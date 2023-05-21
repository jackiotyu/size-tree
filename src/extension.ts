import * as vscode from 'vscode';
import fs from 'fs/promises';
import path from 'path';

enum Commands {
    refresh = 'size-tree.refresh',
    sortByName = 'size-tree.sortByName',
    sortBySize = 'size-tree.sortBySize',
    descend = 'size-tree.descend',
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

type SortType = 'name' | 'size' | 'descend';

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
            this.tooltip = new vscode.MarkdownString(`${file.fsPath} (${file.humanReadableSize})`);
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
        private stop?: (value: unknown) => void;
        private asc: boolean = false;
        private sortKey: 'filename' | 'size' = 'size';
        constructor() {
            this.refresh();
            refreshEvent.event(this.refresh.bind(this));
            sortEvent.event(this.sort.bind(this));
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
                case 'descend':
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
            let pattern = Object.keys({ ...exclude, ...watcherExclude }).join(',');
            vscode.workspace.findFiles('front_end/**', pattern, 30000).then(async (uris) => {
                let list = await Promise.all(
                    uris.map(async (item) => {
                        try {
                            let { size } = await fs.stat(item.fsPath, { throwIfNoEntry: false });
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
    const sortByName = () => sortEvent.fire('name');
    const sortBySize = () => sortEvent.fire('size');
    const descend = () => sortEvent.fire('descend');
    const deleteSelected = (treeItem: TreeItem, selectedItems: TreeItem[]) => {
        console.log(selectedItems, 'selectedItems');
    };

    context.subscriptions.push(vscode.window.registerFileDecorationProvider(new FileDecorationProvider()));
    context.subscriptions.push(
        vscode.commands.registerCommand(Commands.refresh, refresh),
        vscode.commands.registerCommand(Commands.sortByName, sortByName),
        vscode.commands.registerCommand(Commands.sortBySize, sortBySize),
        vscode.commands.registerCommand(Commands.descend, descend),
        vscode.commands.registerCommand(Commands.deleteSelected, deleteSelected),
    );
    context.subscriptions.push(
        vscode.window.createTreeView(viewId, {
            treeDataProvider: new SizeTreeDataProvider(),
            showCollapseAll: true,
            canSelectMany: true,
        }),
    );
    context.subscriptions.push(refreshEvent, sortEvent);
}

// This method is called when your extension is deactivated
export function deactivate() {}
