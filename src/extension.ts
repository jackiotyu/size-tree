import * as vscode from 'vscode';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { resolvePatterns, IExpression, chunkList, convertBytes } from './utils';
import { WorkerPool } from './worker-pool';

import { init, localize } from 'vscode-nls-i18n';

enum Commands {
    refresh = 'size-tree.refresh',
    sortByName = 'size-tree.sortByName',
    sortBySize = 'size-tree.sortBySize',
    descend = 'size-tree.descend',
    ascend = 'size-tree.ascend',
    deleteSelected = 'size-tree.deleteSelected',
    revealInExplorer = 'size-tree.revealInExplorer',
    revealInSystemExplorer = 'size-tree.revealInSystemExplorer',
    copyFilePath = 'size-tree.copyFilePath',
    copyRelativeFilePath = 'size-tree.copyRelativeFilePath',
    groupByType = 'size-tree.groupByType',
    ungroupByType = 'size-tree.ungroupByType',
    revealInSizeTree = 'size-tree.revealInSizeTree',
    openSetting = 'size-tree.openSetting',
    searchInFolder = 'size-tree.searchInFolder',
    clearSearchFolder = 'size-tree.clearSearchFolder',
    deleteGroupFiles = 'size-tree.deleteGroupFiles',
}

enum TreeItemContext {
    fileItem = 'sizeTree.fileItem',
    fileGroup = 'sizeTree.fileGroup',
}

enum TreeItemType {
    fileGroup = 'fileGroup',
    file = 'file',
}

enum Configuration {
    useExcludeDefault = 'useExcludeDefault',
    ignoreRule = 'ignoreRule',
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
    percent: number;
}

type SortType = 'name' | 'size' | 'toggleSort';

const cpusLength = Math.min(os.cpus().length, 6);
let workerPool: WorkerPool;

export function activate(context: vscode.ExtensionContext) {
    init(context.extensionPath);

    workerPool = new WorkerPool(path.resolve(__dirname, './worker.js'), cpusLength);

    const viewId = 'sizeTree';
    const refreshEvent = new vscode.EventEmitter<void>();
    const sortEvent = new vscode.EventEmitter<SortType>();
    const groupEvent = new vscode.EventEmitter<boolean>();
    const sizeTreeVisibleEvent = new vscode.EventEmitter<boolean>();
    const badgeTag = 'SizeTreeBadge';

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
            this.tooltip = new vscode.MarkdownString(``, true);
            this.tooltip.appendMarkdown(localize('treeItem.tooltip.name', file.filename));
            this.tooltip.appendMarkdown(localize('treeItem.tooltip.path', file.fsPath));
            this.tooltip.appendMarkdown(
                localize('treeItem.tooltip.size', `${file.humanReadableSize} (${file.size} B)`),
            );
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
            const percent = group.percent;
            this.description = `${count} - ${totalSize} - ${percent.toFixed(1)}%`;
            this.tooltip = new vscode.MarkdownString('', true);
            this.tooltip.appendMarkdown(localize('treeItem.tooltip.type', type));
            this.tooltip.appendMarkdown(localize('treeItem.tooltip.total', `${count}`));
            this.tooltip.appendMarkdown(localize('treeItem.tooltip.size', `${totalSize} (${group.size} B)`));
            this.tooltip.appendMarkdown(localize('treeItem.tooltip.percent', `${percent.toFixed(5)}%`));
            this.children = children;
            this.contextValue = TreeItemContext.fileGroup;
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
        private useExclude: boolean = true;
        private ignoreRule: string[] = [];
        private _visible = true;
        constructor() {
            refreshEvent.event(this.refresh);
            sortEvent.event(this.sort);
            groupEvent.event(this.handleGroup);
            if (!this.updateExcludeSetting()) {
                this.refresh();
            }
            vscode.commands.executeCommand('setContext', 'sizeTree.asc', this._asc);
            vscode.commands.executeCommand('setContext', 'sizeTree.sortKey', this._sortKey);
            vscode.commands.executeCommand('setContext', 'sizeTree.group', this._group);
            vscode.commands.executeCommand('setContext', 'sizeTree.searchFolder', false);
        }
        updateExcludeSetting() {
            const ignoreRule = vscode.workspace.getConfiguration(viewId).get<string[]>(Configuration.ignoreRule) || [];
            const useExclude = !!vscode.workspace
                .getConfiguration(viewId)
                .get<boolean>(Configuration.useExcludeDefault);
            const needRefresh = this.ignoreRule.toString() !== ignoreRule.toString() || useExclude !== this.useExclude;
            this.ignoreRule = ignoreRule;
            this.useExclude = useExclude;
            needRefresh && this.refresh();
            return needRefresh;
        }
        search(fsPath: string) {
            return this.files.find((file) => file.fsPath === fsPath);
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
            if (folder?.fsPath === this._searchFolder?.fsPath) {
                return;
            }
            vscode.commands.executeCommand('setContext', 'sizeTree.searchFolder', !!folder);
            this._searchFolder = folder;
            this.refresh();
        }
        set visible(visible: boolean) {
            this._visible = visible;
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
            if(!this._visible) {return;};
            const MAX_RESULT = 3000000;
            this.stopSearchToken.cancel();
            this.stopSearchToken.dispose();
            this.stopSearchToken = new vscode.CancellationTokenSource();

            let pattern = '';
            let excludePatternList: string[] = [];
            if (this.useExclude) {
                excludePatternList.push(
                    ...resolvePatterns(
                        vscode.workspace.getConfiguration('files', null).get<IExpression>('exclude'),
                        vscode.workspace.getConfiguration('search', null).get<IExpression>('exclude'),
                    ),
                );
            }
            excludePatternList.push(...this.ignoreRule);
            if (excludePatternList.length) {
                pattern = '**/{' + excludePatternList.map((i) => i.replace('**/', '')).join(',') + '}';
            }

            const includes = this.searchFolder ? new vscode.RelativePattern(this.searchFolder, '**/*') : '';
            vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: localize('progress.searchFiles'),
                    cancellable: true,
                },
                async (progress, token) => {
                    token.onCancellationRequested(this.stop, this);
                    this.stopSearchToken.token.onCancellationRequested(() => {
                        progress.report({ increment: 100 });
                    });
                },
            );
            vscode.workspace.findFiles(includes, pattern, MAX_RESULT, this.stopSearchToken.token).then(async (uris) => {
                try {
                    // let timeStamp = +new Date();
                    // const name = 'workerRun' + timeStamp;
                    // console.time(name);
                    let fsPathList = uris.map((i) => i.fsPath);
                    let cpuNum = cpusLength;
                    let chunkNum = Math.min(Math.floor(fsPathList.length / cpuNum), 400) || 1;
                    let splitFsPathList = chunkList(fsPathList, chunkNum);
                    let stop = false;
                    this.stopSearchToken.token.onCancellationRequested(() => {
                        workerPool.stop();
                        stop = true;
                    });
                    let fileInfoList = await Promise.all(
                        splitFsPathList.map((fsPathList) => {
                            if (stop) {
                                throw Error('isStop');
                            }
                            return workerPool.run<string[], FileInfo>(fsPathList);
                        }),
                    );
                    this.files = fileInfoList.flat(1);
                    // console.timeEnd(name);
                    this.files = this.files.sort(this.sortFunc);
                    this._onDidChangeTreeData.fire();
                } catch (err) {
                    console.log('err', err);
                }
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
                            map.set(extname, { size: 0, list: [], filename: extname, percent: 0 });
                        }
                        map.get(extname)!.size += file.size;
                        map.get(extname)!.list.push(file);
                    });
                    let totalSize = [...map.values()].reduce((total, i) => total + i.size, 0);
                    map.forEach((fileGroup) => {
                        fileGroup.percent = (fileGroup.size / totalSize) * 100;
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
        sizeTreeDateProvider.visible = event.visible;
        if(!event.visible) {
            sizeTreeDateProvider.stop();
        } else {
            sizeTreeDateProvider.refresh();
        }
    });

    sizeTreeDateProvider.onDidChangeTreeData(() => {
        const totalSize = convertBytes(sizeTreeDateProvider.totalSize);
        const count = sizeTreeDateProvider.count;
        sizeTreeView.message = localize('tree.desc.message', `${totalSize}`, `${count}`);
        sizeTreeView.description = localize(
            'tree.desc.findIn',
            sizeTreeDateProvider.searchFolder
                ? sizeTreeDateProvider.searchFolder.fsPath
                : `${vscode.workspace.workspaceFolders?.map((folder) => folder.uri.path).join('\n') || ''}`,
        );
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
        let confirm = localize('btn.confirm');
        let cancel = localize('btn.cancel');
        let res = await vscode.window.showWarningMessage(
            localize('msg.warn.confirmDeleteItems', `${items!.length}`),
            confirm,
            cancel,
        );
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
    const deleteGroupFiles = async (treeItem: FileTypeItem) => {
        let confirm = localize('btn.confirm');
        let cancel = localize('btn.cancel');
        let res = await vscode.window.showWarningMessage(
            localize(
                'msg.warn.confirmDeleteGroup',
                `${treeItem.label}` || localize('msg.emptyExt'),
                treeItem.children.length + ''
            ),
            confirm,
            cancel,
        );
        if (res !== confirm) {
            return;
        }
        let items = treeItem.children.map((i) => i.fsPath);
        Promise.allSettled(items.map((fsPath) => fs.rm(fsPath))).then(() => {
            fileCallback();
        });
    };
    const revealInExplorer = (isSystem: boolean, item: TreeItem) => {
        let fsPath = item.resourceUri?.fsPath;
        if (!fsPath) {
            return vscode.window.showErrorMessage(localize('msg.error.invalidFilePath'));
        }
        if (isSystem) {
            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fsPath));
        } else {
            vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(fsPath));
        }
    };
    const copyFilePath = (isRelativePath: boolean, item: TreeItem) => {
        let fsPath = item.resourceUri?.fsPath;
        if (!fsPath) {
            return;
        }
        if (isRelativePath) {
            vscode.commands.executeCommand('copyRelativeFilePath', vscode.Uri.file(fsPath));
        } else {
            vscode.commands.executeCommand('copyFilePath', vscode.Uri.file(fsPath));
        }
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
        if (!fsPath) {
            return vscode.window.showErrorMessage(localize('msg.error.invalidFolder'));
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
        vscode.commands.registerCommand(Commands.revealInExplorer, (item: TreeItem) => revealInExplorer(false, item)),
        vscode.commands.registerCommand(Commands.revealInSystemExplorer, (item: TreeItem) =>
            revealInExplorer(true, item),
        ),
        vscode.commands.registerCommand(Commands.copyFilePath, (item: TreeItem) => copyFilePath(false, item)),
        vscode.commands.registerCommand(Commands.copyRelativeFilePath, (item: TreeItem) => copyFilePath(true, item)),
        vscode.commands.registerCommand(Commands.groupByType, ungroupByType),
        vscode.commands.registerCommand(Commands.ungroupByType, groupByType),
        vscode.commands.registerCommand(Commands.openSetting, openSetting),
        vscode.commands.registerCommand(Commands.searchInFolder, searchInFolder),
        vscode.commands.registerCommand(Commands.clearSearchFolder, clearSearchFolder),
        vscode.commands.registerCommand(Commands.deleteGroupFiles, deleteGroupFiles),
    );
    context.subscriptions.push(sizeTreeView);
    context.subscriptions.push(
        vscode.workspace.onDidCreateFiles(fileCallback),
        vscode.workspace.onDidDeleteFiles(fileCallback),
        vscode.workspace.onDidRenameFiles(fileCallback),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration(viewId)) {
                return;
            }
            sizeTreeDateProvider.updateExcludeSetting();
        }),
    );
    context.subscriptions.push(refreshEvent, sortEvent, groupEvent, sizeTreeVisibleEvent);
}

// This method is called when your extension is deactivated
export function deactivate() {
    workerPool.destroy(true);
}
