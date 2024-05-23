import * as vscode from 'vscode';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { resolvePatterns, IExpression, chunkList, convertBytes, debounce } from './utils';
import { WorkerPool } from './worker-pool';
import imageExtensions from 'image-extensions';

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
    selectAll = 'size-tree.selectAll',
    deselectAll = 'size-tree.deselectAll',
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
    useCheckbox = 'useCheckbox',
    imagePreview = 'imagePreview',
    imagePreviewMaxHeight = 'imagePreviewMaxHeight',
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
    const refreshEvent = new vscode.EventEmitter<boolean | void>();
    const sortEvent = new vscode.EventEmitter<SortType>();
    const groupEvent = new vscode.EventEmitter<boolean>();
    const sizeTreeVisibleEvent = new vscode.EventEmitter<boolean>();
    const refreshSelectedEvent = new vscode.EventEmitter<void>();
    const imgExtMap = new Map<string, boolean>(imageExtensions.map((item) => ['.' + item, true]));

    class ProxySet<T> extends Set<T> {
        private triggerUpdate = debounce(() => {
            try {
                refreshSelectedEvent.fire();
            } catch {}
        }, 60);
        add(value: T) {
            this.triggerUpdate();
            return super.add(value);
        }
        delete(value: T) {
            this.triggerUpdate();
            return super.delete(value);
        }
        clear() {
            this.triggerUpdate();
            return super.clear();
        }
    }

    const checkItemSet = new ProxySet<string>();
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
            const showImg = vscode.workspace
                .getConfiguration(viewId)
                .get<boolean>(Configuration.imagePreview, true);
            if (showImg && imgExtMap.has(path.extname(file.filename))) {
                const maxHeight = vscode.workspace
                    .getConfiguration(viewId)
                    .get<number>(Configuration.imagePreviewMaxHeight, 300);
                this.tooltip.appendMarkdown(`![${file.filename}](${fileUri}|height=${maxHeight})`);
            }

            this.description = `${file.humanReadableSize}`;
            if (sizeTreeDateProvider.useCheckbox) {
                this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
            }
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
            if (sizeTreeDateProvider.useCheckbox) {
                this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
            }
            this.children = children;
            this.contextValue = TreeItemContext.fileGroup;
        }
    }

    type AllTreeItem = FileTypeItem | TreeItem;

    class SizeTreeDataProvider implements vscode.TreeDataProvider<AllTreeItem> {
        private files: FileInfo[] = [];
        private items: AllTreeItem[] = [];
        private _onDidChangeTreeData: vscode.EventEmitter<AllTreeItem | void> = new vscode.EventEmitter();
        readonly onDidChangeTreeData: vscode.Event<AllTreeItem | void> = this._onDidChangeTreeData.event;
        private _asc: boolean = false;
        private _sortKey: 'filename' | 'size' = 'size';
        private _group: boolean = true;
        private _searchFolder?: vscode.Uri;
        private stopSearchToken: vscode.CancellationTokenSource = new vscode.CancellationTokenSource();
        private useExclude: boolean = true;
        private ignoreRule: string[] = [];
        private _visible = true;
        private _initFinish = false;
        private _useCheckbox = this.useCheckbox;
        constructor() {
            refreshEvent.event(this.refresh);
            sortEvent.event(this.sort);
            groupEvent.event(this.handleGroup);
            this.updateSetting();
            this.refresh().finally(() => (this._initFinish = true));
            vscode.commands.executeCommand('setContext', 'sizeTree.asc', this._asc);
            vscode.commands.executeCommand('setContext', 'sizeTree.sortKey', this._sortKey);
            vscode.commands.executeCommand('setContext', 'sizeTree.group', this._group);
            vscode.commands.executeCommand('setContext', 'sizeTree.searchFolder', false);
            vscode.commands.executeCommand('setContext', 'sizeTree.selectAll', false);
        }
        updateSetting(checkRefresh: boolean = false) {
            const ignoreRule = vscode.workspace.getConfiguration(viewId).get<string[]>(Configuration.ignoreRule) || [];
            const useExclude = !!vscode.workspace
                .getConfiguration(viewId)
                .get<boolean>(Configuration.useExcludeDefault);
            const needRefresh =
                this.ignoreRule.toString() !== ignoreRule.toString() ||
                useExclude !== this.useExclude ||
                this._useCheckbox !== this.useCheckbox;
            this.ignoreRule = ignoreRule;
            this.useExclude = useExclude;
            checkRefresh && needRefresh && this.refresh();
            this._useCheckbox = this.useCheckbox;
            return needRefresh;
        }
        get useCheckbox() {
            return vscode.workspace.getConfiguration(viewId).get<boolean>(Configuration.useCheckbox, false);
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
        get filesMap() {
            return new Map(this.files.map((item) => [item.fsPath, item]));
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
            if (!this._initFinish) return;
            if (visible) {
                this.refresh();
            } else {
                this.stop();
            }
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
            const compare = new Intl.Collator(undefined, { usage: 'sort', numeric: true }).compare;
            switch (true) {
                case this.asc && this.sortKey === 'filename':
                    sort = (a, b) => compare(a.filename, b.filename);
                    break;
                case !this.asc && this.sortKey === 'filename':
                    sort = (a, b) => compare(b.filename, a.filename);
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
        checkAll(check: boolean) {
            if(!check) {
                checkItemSet.clear();
                this.items.forEach(item => item.checkboxState = vscode.TreeItemCheckboxState.Unchecked);
                this._onDidChangeTreeData.fire();
            } else {
                this.items.forEach(item => {
                    item.checkboxState = vscode.TreeItemCheckboxState.Checked;
                    if(item.type === TreeItemType.fileGroup) {
                        item.children.forEach(row => checkItemSet.add(row.fsPath));
                    } else if(item.type === TreeItemType.file && item.resourceUri) {
                        checkItemSet.add(item.resourceUri.fsPath);
                    }
                    this._onDidChangeTreeData.fire(item);
                });
            }
        }
        refresh = async () => {
            if (!this._visible) return;
            checkItemSet.clear();
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
            return vscode.workspace
                .findFiles(includes, pattern, MAX_RESULT, this.stopSearchToken.token)
                .then(async (uris) => {
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
                this.items = [];
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
                            const item = new FileTypeItem(type, group, vscode.TreeItemCollapsibleState.Collapsed);
                            this.items.push(item);
                            return item;
                        });
                }

                return this.files.map((file) => {
                    const item = new TreeItem(file, vscode.TreeItemCollapsibleState.None);
                    this.items.push(item);
                    return item;
                });
            }

            if (element.type === TreeItemType.fileGroup) {
                return element.children.map((file) => {
                    const item = new TreeItem(file, vscode.TreeItemCollapsibleState.None);
                    this.items.push(item);
                    return item;
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

    const updateTreeViewMessage = () => {
        const totalSize = convertBytes(sizeTreeDateProvider.totalSize);
        const count = sizeTreeDateProvider.count;
        let message = localize('tree.desc.message', `${count}`, `${totalSize}`);
        // 展示选中文件数和大小
        if (checkItemSet.size) {
            const filesMap = sizeTreeDateProvider.filesMap;
            const selectedItems = [...checkItemSet]
                .map((fsPath) => filesMap.get(fsPath))
                .filter((i) => i) as FileInfo[];
            const selectedSize = selectedItems.reduce<number>((totalSize, item) => (totalSize += item.size), 0);
            const selectedCount = selectedItems.length;
            const selectedCountText = `${selectedCount}`;
            message += ` ⋅ ${localize('tree.desc.selectMessage', selectedCountText, `${convertBytes(selectedSize)}`)}`;
            vscode.commands.executeCommand('setContext', 'sizeTree.selectAll', count === selectedCount);
        } else {
            vscode.commands.executeCommand('setContext', 'sizeTree.selectAll', false);
        }
        sizeTreeView.message = message;
    };

    refreshSelectedEvent.event(() => {
        updateTreeViewMessage();
    });

    sizeTreeView.onDidChangeVisibility((event) => {
        sizeTreeDateProvider.visible = event.visible;
    });

    sizeTreeDateProvider.onDidChangeTreeData(() => {
        updateTreeViewMessage();
        sizeTreeView.description = localize(
            'tree.desc.findIn',
            sizeTreeDateProvider.searchFolder
                ? sizeTreeDateProvider.searchFolder.fsPath
                : `${vscode.workspace.workspaceFolders?.map((folder) => folder.uri.path).join('\n') || ''}`,
        );
    });

    sizeTreeView.onDidChangeCheckboxState &&
        sizeTreeView.onDidChangeCheckboxState((event) => {
            if (!sizeTreeDateProvider.useCheckbox) return;
            const groupCheckChange = (group: FileTypeItem, checked: boolean) => {
                checked
                    ? group.children.forEach((item) => checkItemSet.add(item.fsPath))
                    : group.children.forEach((item) => checkItemSet.delete(item.fsPath));
            };
            const fileCheckChange = (item: TreeItem, checked: boolean) => {
                checked ? checkItemSet.add(item.resourceUri!.fsPath) : checkItemSet.delete(item.resourceUri!.fsPath);
            };
            let childItems: Array<[TreeItem, vscode.TreeItemCheckboxState]> = [];
            let parentItems: Array<[FileTypeItem, vscode.TreeItemCheckboxState]> = [];
            event.items.forEach(([item, state]) => {
                if (item.type === TreeItemType.fileGroup) parentItems.push([item, state]);
                else childItems.push([item, state]);
            });
            if (childItems.length) {
                childItems.forEach(([item, state]) => {
                    fileCheckChange(item, state === vscode.TreeItemCheckboxState.Checked);
                });
            } else {
                parentItems.forEach(([item, state]) => {
                    groupCheckChange(item, state === vscode.TreeItemCheckboxState.Checked);
                });
            }
        });

    const refresh = () => {
        refreshEvent.fire();
    };
    const sortByName = () => sortEvent.fire('size');
    const sortBySize = () => sortEvent.fire('name');
    const toggleSort = () => sortEvent.fire('toggleSort');
    const deleteSelected = async (treeItem: TreeItem, selectedItems: TreeItem[]) => {
        let items: string[];
        if (sizeTreeDateProvider.useCheckbox) {
            items = [...checkItemSet];
        } else {
            items = (!selectedItems?.length ? [treeItem] : selectedItems).map((item) => item.resourceUri!.fsPath);
        }
        if (!items?.length) return;
        let confirm = localize('btn.confirm');
        let cancel = localize('btn.cancel');
        let res = await vscode.window.showWarningMessage(
            localize('msg.warn.confirmDeleteItems', `${items!.length}`),
            confirm,
            cancel,
        );
        if (res !== confirm) return;
        Promise.allSettled(
            items.map((item) => {
                return fs.rm(item);
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
                treeItem.children.length + '',
            ),
            confirm,
            cancel,
        );
        if (res !== confirm) return;
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
        if (!fsPath) return;
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
    const selectAll = () => {
        sizeTreeDateProvider.checkAll(true);
    };
    const deselectAll = () => {
        sizeTreeDateProvider.checkAll(false);
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
        vscode.commands.registerCommand(Commands.selectAll, selectAll),
        vscode.commands.registerCommand(Commands.deselectAll, deselectAll),
    );
    context.subscriptions.push(sizeTreeView);
    context.subscriptions.push(
        vscode.workspace.onDidCreateFiles(fileCallback),
        vscode.workspace.onDidDeleteFiles(fileCallback),
        vscode.workspace.onDidRenameFiles(fileCallback),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration(viewId)) return;
            sizeTreeDateProvider.updateSetting(true);
        }),
    );
    context.subscriptions.push(refreshEvent, sortEvent, groupEvent, sizeTreeVisibleEvent, refreshSelectedEvent);
    context.subscriptions.push({ dispose: () => checkItemSet.clear() });
}

// This method is called when your extension is deactivated
export function deactivate() {
    workerPool.destroy(true);
}
