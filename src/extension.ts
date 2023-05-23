import * as vscode from 'vscode';
import fs from 'fs/promises';
import path from 'path';

enum Commands {
    refresh = 'size-tree.refresh',
    sortByName = 'size-tree.sortByName',
    sortBySize = 'size-tree.sortBySize',
    descend = 'size-tree.descend',
    ascend = 'size-tree.ascend',
    deleteSelected = 'size-tree.deleteSelected',
}

enum TreeItemContext {
    fileItem = 'sizeTree.fileItem'
}

interface FileInfo {
    filename: string;
    size: number;
    humanReadableSize: string;
    fsPath: string;
}

type SortType = 'name' | 'size' | 'toggleSort';

export function activate(context: vscode.ExtensionContext) {
    const viewId = 'sizeTree';
    const refreshEvent = new vscode.EventEmitter<void>();
    const sortEvent = new vscode.EventEmitter<SortType>();
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

    class SizeTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
        private files: FileInfo[] = [];
        private _onDidChangeTreeData: vscode.EventEmitter<void> = new vscode.EventEmitter();
        readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;
        private _asc: boolean = false;
        private _sortKey: 'filename' | 'size' = 'size';
        constructor() {
            this.refresh();
            refreshEvent.event(this.refresh.bind(this));
            sortEvent.event(this.sort.bind(this));
            vscode.commands.executeCommand('setContext', 'sizeTree.asc', this._asc);
            vscode.commands.executeCommand('setContext', 'sizeTree.sortKey', this._sortKey);
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
        sort(sortType: SortType) {
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
        }
        get sortFunc() {
            let sort: (a: FileInfo, b: FileInfo) => number = (a, b) => 0;
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
        refresh() {
            let exclude = vscode.workspace.getConfiguration('files').get('exclude') as Record<string, boolean>;
            let watcherExclude = vscode.workspace.getConfiguration('files').get('watcherExclude') as Record<
                string,
                boolean
            >;
            let excludePatternList: string[] = [];
            for(const key in exclude) {
                exclude[key] && excludePatternList.push(key);
            }
            for(const key in watcherExclude) {
                watcherExclude[key] && excludePatternList.push(key);
            }
            let pattern = '**/{' + excludePatternList.map(i => i.replace('**/', '')).join(',') + '}';
            vscode.workspace.findFiles('', pattern).then(async (uris) => {
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
        }
        getTreeItem(element: TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
            return Promise.resolve(element);
        }
        getChildren(element?: TreeItem | undefined): vscode.ProviderResult<TreeItem[]> {
            if (!element) {
                return this.files.map((file) => {
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


    const refresh = () => refreshEvent.fire();
    const sortByName = () => sortEvent.fire('size');
    const sortBySize = () => sortEvent.fire('name');
    const toggleSort = () => sortEvent.fire('toggleSort');
    const deleteSelected = async (treeItem: TreeItem, selectedItems: TreeItem[]) => {
        if(!selectedItems.length) {
            return;
        }
        let confirm = 'confirm';
        let cancel = 'cancel';
        let res = await vscode.window.showWarningMessage('Confirm Delete?', confirm, cancel);
        if(res !== confirm) {
            return;
        }
        Promise.allSettled(selectedItems.map(item => {
            let fsPath = item.resourceUri!.fsPath;
            fs.rm(fsPath);
        })).then(() => {
            fileCallback();
        });
    };
    const fileCallback = () => vscode.commands.executeCommand(Commands.refresh);

    context.subscriptions.push(vscode.window.registerFileDecorationProvider(new FileDecorationProvider()));
    context.subscriptions.push(
        vscode.commands.registerCommand(Commands.refresh, refresh),
        vscode.commands.registerCommand(Commands.sortByName, sortByName),
        vscode.commands.registerCommand(Commands.sortBySize, sortBySize),
        vscode.commands.registerCommand(Commands.descend, toggleSort),
        vscode.commands.registerCommand(Commands.ascend, toggleSort),
        vscode.commands.registerCommand(Commands.deleteSelected, deleteSelected),
    );
    context.subscriptions.push(
        vscode.window.createTreeView(viewId, {
            treeDataProvider: new SizeTreeDataProvider(),
            showCollapseAll: true,
            canSelectMany: true,
        }),
    );
    context.subscriptions.push(
        vscode.workspace.onDidCreateFiles(fileCallback),
        vscode.workspace.onDidDeleteFiles(fileCallback),
        vscode.workspace.onDidRenameFiles(fileCallback),
    );
    context.subscriptions.push(refreshEvent, sortEvent);
}

// This method is called when your extension is deactivated
export function deactivate() {}
