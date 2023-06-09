import * as vscode from 'vscode';
import fs from 'fs/promises';
import path from 'path';
import { resolvePatterns, IExpression } from './utils';

enum Commands {
    refresh = 'size-tree.refresh',
    sortByName = 'size-tree.sortByName',
    sortBySize = 'size-tree.sortBySize',
    descend = 'size-tree.descend',
    ascend = 'size-tree.ascend',
    deleteSelected = 'size-tree.deleteSelected',
    revealInExplorer = 'size-tree.revealInExplorer',
    groupByType = 'size-tree.groupByType',
    ungroupByType = 'size-tree.ungroupByType',
    revealInSizeTree = 'size-tree.revealInSizeTree',
    openSetting = 'size-tree.openSetting',
    searchInFolder = 'size-tree.searchInFolder',
    clearSearchFolder = 'size-tree.clearSearchFolder',
}

enum TreeItemContext {
    fileItem = 'sizeTree.fileItem',
}

enum TreeItemType {
    fileGroup = 'fileGroup',
    file = 'file',
}

enum Configuration {
    useExcludeDefault = 'useExcludeDefault'
}

interface FileInfo {
    filename: string;
    size: number;
    humanReadableSize: string;
    fsPath: string;
}

type SimpleFileInfo = Pick<FileInfo, 'filename' | 'size'>;

interface FileGroup {
    filename: string;
    size: number;
    list: FileInfo[];
}

type SortType = 'name' | 'size' | 'toggleSort';

export function activate(context: vscode.ExtensionContext) {
    const viewId = 'sizeTree';
    const refreshEvent = new vscode.EventEmitter<void>();
    const sortEvent = new vscode.EventEmitter<SortType>();
    const groupEvent = new vscode.EventEmitter<boolean>();
    const sizeTreeVisibleEvent = new vscode.EventEmitter<boolean>();
    const badgeTag = 'SizeTreeBadge';
    const convertBytes = function (bytes: number) {
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        if (bytes === 0) {
            return 'n/a';
        }
        const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)) + '', 10);
        if (i === 0) {
            return bytes + ' ' + sizes[i];
        }
        return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
    };

    class TreeItem extends vscode.TreeItem {
        readonly type = TreeItemType.file;
        constructor(file: FileInfo, collapsibleState: vscode.TreeItemCollapsibleState) {
            const fileUri = vscode.Uri.file(file.fsPath);
            super(
                fileUri.with({
                    scheme: badgeTag,
                    query: file.humanReadableSize.replace(/[\d\. ]+/, '').replace('n/a', '0'),
                }),
                collapsibleState,
            );
            this.iconPath = vscode.ThemeIcon.File;
            this.tooltip = new vscode.MarkdownString(``);
            this.tooltip.appendMarkdown(`- name: ${file.filename}\n`);
            this.tooltip.appendMarkdown(`- path: *${file.fsPath}*\n`);
            this.tooltip.appendMarkdown(`- size: ${file.humanReadableSize}`);
            this.description = `${file.humanReadableSize}`;
            this.contextValue = TreeItemContext.fileItem;
            this.command = {
                command: 'vscode.open',
                arguments: [fileUri],
                title: 'open file',
            };
        }
    }

    class FileTypeItem extends vscode.TreeItem {
        readonly type = TreeItemType.fileGroup;
        children: FileInfo[];
        constructor(type: string, group: FileGroup, collapsibleState: vscode.TreeItemCollapsibleState) {
            const fileUri = vscode.Uri.file(`temp${type}`);
            super(fileUri, collapsibleState);
            this.iconPath = vscode.ThemeIcon.File;
            this.label = type;
            let children = group.list;
            const count = children.length;
            const totalSize = convertBytes(group.size);
            this.description = `${count} - ${totalSize}`;
            this.tooltip = new vscode.MarkdownString('');
            this.tooltip.appendMarkdown(`- type: ${type}\n`);
            this.tooltip.appendMarkdown(`- total: ${count}\n`);
            this.tooltip.appendMarkdown(`- size: ${totalSize}\n`);
            this.children = children;
        }
    }

    type AllTreeItem = FileTypeItem | TreeItem;

    class SizeTreeDataProvider implements vscode.TreeDataProvider<AllTreeItem> {
        private files: FileInfo[] = [];
        private _onDidChangeTreeData: vscode.EventEmitter<void> = new vscode.EventEmitter();
        readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;
        private _asc: boolean = false;
        private _sortKey: 'filename' | 'size' = 'size';
        private _group: boolean = true;
        private _searchFolder?: vscode.Uri;
        private stopSearchToken: vscode.CancellationTokenSource = new vscode.CancellationTokenSource();
        private _useExclude: boolean = true;
        constructor() {
            this.refresh();
            refreshEvent.event(this.refresh);
            sortEvent.event(this.sort);
            groupEvent.event(this.handleGroup);
            this.updateExcludeSetting();
            vscode.commands.executeCommand('setContext', 'sizeTree.asc', this._asc);
            vscode.commands.executeCommand('setContext', 'sizeTree.sortKey', this._sortKey);
            vscode.commands.executeCommand('setContext', 'sizeTree.group', this._group);
            vscode.commands.executeCommand('setContext', 'sizeTree.searchFolder', false);
        }
        updateExcludeSetting() {
            this.useExclude = !!vscode.workspace.getConfiguration(viewId).get<boolean>(Configuration.useExcludeDefault);
        }
        search(fsPath: string) {
            return this.files.find((file) => file.fsPath === fsPath);
        }
        get useExclude() {
            return this._useExclude;
        }
        set useExclude(value: boolean) {
            if(!!value === this._useExclude) {return;}
            this._useExclude = !!value;
            this.refresh();
        }
        get totalSize() {
            return this.files.reduce((total, file) => ((total += file.size || 0), total), 0);
        }
        get count() {
            return this.files.length;
        }
        get asc() {
            return this._asc;
        }
        set asc(value) {
            vscode.commands.executeCommand('setContext', 'sizeTree.asc', value);
            this._asc = value;
        }
        get sortKey() {
            return this._sortKey;
        }
        set sortKey(value) {
            vscode.commands.executeCommand('setContext', 'sizeTree.sortKey', value);
            this._sortKey = value;
        }
        get group() {
            return this._group;
        }
        set group(value) {
            vscode.commands.executeCommand('setContext', 'sizeTree.group', value);
            this._group = value;
        }
        get searchFolder(): vscode.Uri | undefined {
            return this._searchFolder;
        }
        set searchFolder(folder: vscode.Uri | undefined) {
            if(folder?.fsPath === this._searchFolder?.fsPath) {return;}
            vscode.commands.executeCommand('setContext', 'sizeTree.searchFolder', !!folder);
            this._searchFolder = folder;
            this.refresh();
        }
        handleGroup = (group: boolean) => {
            this.group = group;
            this._onDidChangeTreeData.fire();
        };
        sort = (sortType: SortType) => {
            switch (sortType) {
                case 'name':
                    this.sortKey = 'filename';
                    this.asc = true;
                    return this.sortByName();
                case 'size':
                    this.sortKey = 'size';
                    this.asc = false;
                    return this.sortBySize();
                case 'toggleSort':
                    this.asc = !this.asc;
                    return this.descend();
            }
        };
        get sortFunc() {
            let sort: (a: SimpleFileInfo, b: SimpleFileInfo) => number = (a, b) => 0;
            switch (true) {
                case this.asc && this.sortKey === 'filename':
                    sort = (a, b) => a.filename.localeCompare(b.filename);
                    break;
                case !this.asc && this.sortKey === 'filename':
                    sort = (a, b) => b.filename.localeCompare(a.filename);
                    break;
                case this.asc && this.sortKey === 'size':
                    sort = (a, b) => a.size - b.size;
                    break;
                case !this.asc && this.sortKey === 'size':
                    sort = (a, b) => b.size - a.size;
                    break;
            }
            return sort;
        }
        descend() {
            this.files = this.files.sort(this.sortFunc);
            this._onDidChangeTreeData.fire();
        }
        sortByName() {
            this.files = this.files.sort(this.sortFunc);
            this._onDidChangeTreeData.fire();
        }
        sortBySize() {
            this.files = this.files.sort(this.sortFunc);
            this._onDidChangeTreeData.fire();
        }
        refresh = () => {
            const MAX_RESULT = 3000000;
            this.stopSearchToken.cancel();
            this.stopSearchToken = new vscode.CancellationTokenSource();

            let pattern = '';
            if(this.useExclude) {
                let excludePatternList: string[] = resolvePatterns(
                    vscode.workspace.getConfiguration('files').get<IExpression>('exclude'),
                    vscode.workspace.getConfiguration('search').get<IExpression>('exclude'),
                );
                pattern = '**/{' + excludePatternList.map((i) => i.replace('**/', '')).join(',') + '}';
            }

            const includes = this.searchFolder
                ? new vscode.RelativePattern(this.searchFolder, '**/*')
                : '';

            vscode.workspace.findFiles(includes, pattern, MAX_RESULT, this.stopSearchToken.token).then(async (uris) => {
                let list = await Promise.all(
                    uris.map(async (item) => {
                        try {
                            let { size } = await fs.stat(item.fsPath);
                            let filename = path.basename(item.fsPath);
                            return { filename, size: size, fsPath: item.fsPath, humanReadableSize: convertBytes(size) };
                        } catch (err) {
                            console.log(err, 'err');
                            return null;
                        }
                    }),
                );
                this.files = list.filter((i) => i !== null) as unknown as FileInfo[];
                this.files = this.files.sort(this.sortFunc);
                this._onDidChangeTreeData.fire();
            });
        };
        stop() {
            this.stopSearchToken.cancel();
        }
        getTreeItem(element: AllTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
            return Promise.resolve(element);
        }
        getChildren(element?: AllTreeItem | undefined): vscode.ProviderResult<AllTreeItem[]> {
            if (!element) {
                if (this.group) {
                    let map = new Map<string, FileGroup>();
                    this.files.forEach((file) => {
                        let extname = path.extname(file.fsPath);
                        if (!map.has(extname)) {
                            map.set(extname, { size: 0, list: [], filename: extname });
                        }
                        map.get(extname)!.size += file.size;
                        map.get(extname)!.list.push(file);
                    });
                    return [...map.entries()]
                        .sort((a, b) => this.sortFunc(a[1], b[1]))
                        .map(([type, group]) => {
                            return new FileTypeItem(type, group, vscode.TreeItemCollapsibleState.Collapsed);
                        });
                }

                return this.files.map((file) => {
                    return new TreeItem(file, vscode.TreeItemCollapsibleState.None);
                });
            }

            if (element.type === TreeItemType.fileGroup) {
                return element.children.map((file) => {
                    return new TreeItem(file, vscode.TreeItemCollapsibleState.None);
                });
            }

            return [];
        }
    }

    class FileDecorationProvider implements vscode.FileDecorationProvider {
        provideFileDecoration(
            uri: vscode.Uri,
            token: vscode.CancellationToken,
        ): vscode.ProviderResult<vscode.FileDecoration> {
            if (uri.scheme === badgeTag) {
                let badge = uri.query;
                return {
                    badge,
                };
            }
        }
    }

    const sizeTreeDateProvider = new SizeTreeDataProvider();

    const sizeTreeView = vscode.window.createTreeView(viewId, {
        treeDataProvider: sizeTreeDateProvider,
        showCollapseAll: true,
        canSelectMany: true,
    });

    sizeTreeView.onDidChangeVisibility((event) => {
        !event.visible && sizeTreeDateProvider.stop();
    });

    sizeTreeDateProvider.onDidChangeTreeData(() => {
        const totalSize = convertBytes(sizeTreeDateProvider.totalSize);
        const count = sizeTreeDateProvider.count;
        sizeTreeView.message = `📦 size ${totalSize} | count ${count}`;
        // TODO 搜索排除文件夹
        sizeTreeView.description = sizeTreeDateProvider.searchFolder
        ? `find in: ${sizeTreeDateProvider.searchFolder.fsPath}`
        : `find in: ${vscode.workspace.workspaceFolders
            ?.map((folder) => folder.uri.path)
            .join('\n')}`;
    });


    const refresh = () => refreshEvent.fire();
    const sortByName = () => sortEvent.fire('size');
    const sortBySize = () => sortEvent.fire('name');
    const toggleSort = () => sortEvent.fire('toggleSort');
    const deleteSelected = async (treeItem: TreeItem, selectedItems: TreeItem[]) => {
        let items = !selectedItems?.length ? [treeItem] : selectedItems;
        if (!items?.length) {
            return;
        }
        let confirm = 'confirm';
        let cancel = 'cancel';
        let res = await vscode.window.showWarningMessage('Confirm Delete?', confirm, cancel);
        if (res !== confirm) {
            return;
        }
        Promise.allSettled(
            items.map((item) => {
                let fsPath = item.resourceUri!.fsPath;
                return fs.rm(fsPath);
            }),
        ).then(() => {
            fileCallback();
        });
    };
    const revealInExplorer = (item: TreeItem) => {
        let fsPath = item.resourceUri?.fsPath;
        if(!fsPath) {return vscode.window.showErrorMessage('File path is invalid');}
        void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.parse(fsPath));
    };
    const fileCallback = () => vscode.commands.executeCommand(Commands.refresh);
    const groupByType = () => {
        groupEvent.fire(true);
    };
    const ungroupByType = () => {
        groupEvent.fire(false);
    };
    const openSetting = () => {
        void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:jackiotyu.size-tree`);
    };
    const searchInFolder = async (item: vscode.Uri) => {
        let fsPath = item?.fsPath;
        if(!fsPath) {
            return vscode.window.showErrorMessage('Current folder invalid, Please select folder in explorer.');
        }
        sizeTreeDateProvider.searchFolder = item;
        vscode.commands.executeCommand(`${viewId}.focus`);
    };
    const clearSearchFolder = () => {
        sizeTreeDateProvider.searchFolder = void 0;
    };

    context.subscriptions.push(vscode.window.registerFileDecorationProvider(new FileDecorationProvider()));
    context.subscriptions.push(
        vscode.commands.registerCommand(Commands.refresh, refresh),
        vscode.commands.registerCommand(Commands.sortByName, sortByName),
        vscode.commands.registerCommand(Commands.sortBySize, sortBySize),
        vscode.commands.registerCommand(Commands.descend, toggleSort),
        vscode.commands.registerCommand(Commands.ascend, toggleSort),
        vscode.commands.registerCommand(Commands.deleteSelected, deleteSelected),
        vscode.commands.registerCommand(Commands.revealInExplorer, revealInExplorer),
        vscode.commands.registerCommand(Commands.groupByType, ungroupByType),
        vscode.commands.registerCommand(Commands.ungroupByType, groupByType),
        vscode.commands.registerCommand(Commands.openSetting, openSetting),
        vscode.commands.registerCommand(Commands.searchInFolder, searchInFolder),
        vscode.commands.registerCommand(Commands.clearSearchFolder, clearSearchFolder)
    );
    context.subscriptions.push(sizeTreeView);
    context.subscriptions.push(
        vscode.workspace.onDidCreateFiles(fileCallback),
        vscode.workspace.onDidDeleteFiles(fileCallback),
        vscode.workspace.onDidRenameFiles(fileCallback),
        vscode.workspace.onDidChangeConfiguration(event => {
            if(!event.affectsConfiguration(viewId)) {return;}
            sizeTreeDateProvider.updateExcludeSetting();
        })
    );
    context.subscriptions.push(refreshEvent, sortEvent, groupEvent, sizeTreeVisibleEvent);
}

// This method is called when your extension is deactivated
export function deactivate() {}
