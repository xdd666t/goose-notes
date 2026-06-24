import type { Page } from "@/types";
import { useNotebooks } from "../../../useNotebooks";
import { useTabs } from "../../../useTabs";
import {
  scanLocalFolderPages,
  parseLocalMarkdownContent,
  localFileTitleFromPath,
} from "@/lib/local-folder-scanner";
import { setLocalMdSnapshot, deleteLocalMdSnapshot } from "@/lib/local-md-snapshot";
import {
  readLocalPageIdMap,
  resolveOrCreateStableId,
  toRelativePath,
  writeLocalPageIdMap,
} from "@/lib/local-page-idmap";
import { resolveHistoryBackend } from "@/lib/history/backend";
import { localPageMetadataCache } from "../../persistence";
import type { StoreSet, StoreGet } from "../hydrate";

// 外部进程修改了文件后，把磁盘内容重新读入 store（不触发脏标记 / 自动保存）。
// 若该文件有未保存的本地编辑（dirty）则跳过，避免覆盖用户输入。
export const reloadLocalPageFromDiskAction = async (
  set: StoreSet,
  get: StoreGet,
  pageId: string,
): Promise<void> => {
  if (typeof window === "undefined" || !window.gooseFs) return;

  const page = get().pages[pageId];
  if (!page || page.isFolder || !page.localFilePath) return;
  if (get().dirtyLocalPageIds[pageId]) return;

  const fs = window.gooseFs;
  const filePath = page.localFilePath;

  let markdown: string | null;
  let readError: string | undefined;
  try {
    if (fs.readFileStatAsync) {
      const result = await fs.readFileStatAsync(filePath);
      markdown = result.ok ? result.content ?? "" : null;
      readError = result.error || undefined;
    } else if (fs.readFileStat) {
      const result = fs.readFileStat(filePath);
      markdown = result.ok ? result.content ?? "" : null;
      readError = result.error || undefined;
    } else if (fs.readFileAsync) {
      markdown = await fs.readFileAsync(filePath);
    } else {
      markdown = fs.readFile(filePath);
    }
  } catch (error) {
    console.error("[local-folder] reload read failed", error);
    return;
  }

  const parsed = await parseLocalMarkdownContent(
    markdown,
    localFileTitleFromPath(filePath),
    readError,
  );

  // 外部变更后更新快照，保证下次写盘前 diff 与磁盘最新状态比较。
  if (typeof markdown === "string") {
    setLocalMdSnapshot(filePath, markdown);
  }

  set((state) => {
    const current = state.pages[pageId];
    if (!current) return state;
    return {
      pages: {
        ...state.pages,
        [pageId]: {
          ...current,
          content: parsed.content,
          localFrontmatter: parsed.frontmatter,
          localReadState: parsed.readState,
          localReadError: parsed.readError,
          updatedAt: Date.now(),
        },
      },
    };
  });

  // 当前正在编辑的文件被外部修改 → 通知编辑器重载内容。
  if (get().activePageId === pageId) {
    window.dispatchEvent(
      new CustomEvent("goose-note:reload-active-editor", {
        detail: { pageId },
      }),
    );
  }
};

export const loadLocalFolderPagesAction = async (
  set: StoreSet,
  get: StoreGet,
  notebookId: string,
  basePath: string,
  options?: { showWelcome?: boolean },
) => {
  if (typeof window === "undefined" || !window.gooseFs) return;

  const previousActivePageId = get().activePageId;
  const previousActivePage = previousActivePageId
    ? get().pages[previousActivePageId]
    : undefined;
  const previousActiveInNotebook =
    previousActivePage?.workspaceId === notebookId
      ? previousActivePageId
      : null;
  useNotebooks.getState().setLocalFolderLoadState(notebookId, {
    status: "loading",
    startedAt: Date.now(),
  });

  const currentPages = get().pages;
  const hasExistingPages = Object.values(currentPages).some(
    (p) => p.workspaceId === notebookId,
  );

  if (hasExistingPages) {
    Object.values(currentPages).forEach((p) => {
      if (p.workspaceId === notebookId) {
        localPageMetadataCache.set(p.id, {
          isFavorite: p.isFavorite,
          favoriteOrder: p.favoriteOrder,
          icon: p.icon,
          isPinned: p.isPinned,
          pinnedAt: p.pinnedAt,
        });
      }
    });
  }

  get().removePagesByWorkspaceId(notebookId);
  try {
    const localPages = await scanLocalFolderPages({
      notebookId,
      basePath,
      gooseFs: window.gooseFs,
    });

    set((state) => {
      const updated = {
        ...state.pages,
        ...localPages.reduce(
          (acc, page) => {
            const existing = localPageMetadataCache.get(page.id);
            if (existing) {
              if (existing.isFavorite !== undefined) {
                page.isFavorite = existing.isFavorite;
              }
              if (existing.favoriteOrder !== undefined) {
                page.favoriteOrder = existing.favoriteOrder;
              }
              if (existing.icon) {
                page.icon = existing.icon;
              }
              if (existing.isPinned !== undefined) {
                page.isPinned = existing.isPinned;
              }
              if (existing.pinnedAt !== undefined) {
                page.pinnedAt = existing.pinnedAt;
              }
            }

            acc[page.id] = page;
            return acc;
          },
          {} as Record<string, Page>,
        ),
      };

      const { pendingNavigatePageId } = state;
      const result: any = { pages: updated };
      let nextActivePageId = state.activePageId;
      let handledNavigation = false;

      if (pendingNavigatePageId && updated[pendingNavigatePageId]) {
        nextActivePageId = pendingNavigatePageId;
        result.activePageId = nextActivePageId;
        result.expandPageId = nextActivePageId;
        result.pendingNavigatePageId = null;
        handledNavigation = true;
      }

      if (!handledNavigation) {
        const activeNotebookId = useNotebooks.getState().activeNotebookId;
        if (activeNotebookId === notebookId) {
          const autoOpenLastNote =
            typeof window !== "undefined"
              ? (window as any).__gooseNoteAutoOpenLastNote !== false
              : true;
          const allowAutoRestore = autoOpenLastNote === true;
          const notebook = useNotebooks.getState().notebooks[notebookId];
          const isLocalFolder = notebook?.source === "local-folder";

          if (allowAutoRestore || !isLocalFolder) {
            const lastActivePageId = useNotebooks
              .getState()
              .getLastActivePage(notebookId);
            const pageIdSet = new Set(localPages.map((p) => p.id));

            if (lastActivePageId && pageIdSet.has(lastActivePageId)) {
              nextActivePageId = lastActivePageId;
            } else if (
              previousActiveInNotebook &&
              pageIdSet.has(previousActiveInNotebook)
            ) {
              nextActivePageId = previousActiveInNotebook;
            } else if (!isLocalFolder) {
              const firstPage = localPages
                .filter((p) => !p.trashedAt)
                .sort(
                  (a, b) =>
                    (a.order ?? a.createdAt) -
                    (b.order ?? b.createdAt),
                )[0];
              if (firstPage) {
                nextActivePageId = firstPage.id;
              }
            }

            if (nextActivePageId !== state.activePageId) {
              result.activePageId = nextActivePageId;
            }
          }
        }
      }

      if (options?.showWelcome) {
        // 打开本地文件夹后：文件夹内有笔记则直接定位到首篇（按 order/创建时间），
        // 只有真正的空文件夹才回落到欢迎空状态。修复「加了文件夹却仍停在新建引导」。
        const firstPage = localPages
          .filter((p) => !p.trashedAt)
          .sort(
            (a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt),
          )[0];
        if (firstPage) {
          result.activePageId = firstPage.id;
          result.expandPageId = firstPage.id;
        } else {
          result.activePageId = null;
          result.expandPageId = null;
        }
        result.pendingNavigatePageId = null;
      }

      const hasActivePageUpdate = Object.prototype.hasOwnProperty.call(
        result,
        "activePageId",
      );
      const currentActive = hasActivePageUpdate
        ? result.activePageId
        : state.activePageId;
      const activeNotebookId = useNotebooks.getState().activeNotebookId;
      if (activeNotebookId === notebookId && currentActive) {
        useNotebooks.getState().setLastActivePage(notebookId, currentActive);
      }

      return result;
    });
  } finally {
    useNotebooks.getState().setLocalFolderLoadState(notebookId, {
      status: "ready",
      finishedAt: Date.now(),
    });
    // 该笔记本页面已就绪：清理指向已不存在文件的持久化标签。
    try {
      const { useTabs } = await import("../../../useTabs");
      useTabs.getState().reconcileTabs();
    } catch {
      // 忽略
    }
  }
};

// ── 增量 watch 辅助：单页从 store 移除 ────────────────────────────────────────
/**
 * 文件被外部删除/移走时，从 store 中移除该页面并处理 activePage / tab 善后。
 * 不触发全量重扫。
 */
export const removeSingleLocalPageAction = (
  set: StoreSet,
  get: StoreGet,
  filePath: string,
): void => {
  const pages = get().pages;
  const target = Object.values(pages).find(
    (p) => p.localFilePath === filePath || p.localFilePath?.replace(/\\/g, "/") === filePath.replace(/\\/g, "/"),
  );
  if (!target) return;

  const pageId = target.id;

  // 清除快照
  deleteLocalMdSnapshot(filePath);

  // 清理历史快照（.goose/history/ 下的孤儿数据）：必须在 store 记录删除前
  // 调用，删后 resolveHistoryBackend 解析不到 notebook.localPath。
  void resolveHistoryBackend(pageId).dropAll(pageId);

  set((state) => {
    const newPages = { ...state.pages };
    delete newPages[pageId];

    const nextActivePageId =
      state.activePageId === pageId ? null : state.activePageId;

    const newDirty = { ...state.dirtyLocalPageIds };
    delete newDirty[pageId];

    return {
      pages: newPages,
      activePageId: nextActivePageId,
      dirtyLocalPageIds: newDirty,
    };
  });

  // 关闭指向该页面的标签
  const tabs = useTabs.getState();
  const tab = tabs.openTabs.find((t) => t.pageId === pageId);
  if (tab) {
    tabs.closeTab(tab.id);
  }
};

// ── 增量 watch 辅助：单个新文件扫入 store ────────────────────────────────────
/**
 * 文件被外部新建/移入时，读取文件内容、构造 Page 对象并合并进 store。
 * 若该 pageId 已存在（例如 rename 后先 add 再 remove）则更新内容。
 * 不触发全量重扫，不触发 activePage 跳转。
 */
export const addSingleLocalPageAction = async (
  set: StoreSet,
  get: StoreGet,
  notebookId: string,
  basePath: string,
  filePath: string,
): Promise<void> => {
  if (typeof window === "undefined" || !window.gooseFs) return;

  const fs = window.gooseFs;

  // 只处理 markdown 文件（非目录）
  if (!/\.(md|markdown)$/i.test(filePath)) return;

  const fallbackTitle = localFileTitleFromPath(filePath);
  const relativePath = toRelativePath(basePath, filePath);
  const idMap = readLocalPageIdMap(notebookId);
  const { id: pageId, dirty } = resolveOrCreateStableId(
    notebookId,
    relativePath,
    idMap,
  );
  if (dirty) {
    writeLocalPageIdMap(notebookId, idMap);
  }

  let markdown: string | null;
  let readError: string | undefined;
  try {
    if (fs.readFileStatAsync) {
      const result = await fs.readFileStatAsync(filePath);
      markdown = result.ok ? (result.content ?? "") : null;
      readError = result.error || undefined;
    } else if (fs.readFileStat) {
      const result = fs.readFileStat(filePath);
      markdown = result.ok ? (result.content ?? "") : null;
      readError = result.error || undefined;
    } else if (fs.readFileAsync) {
      markdown = await fs.readFileAsync(filePath);
    } else {
      markdown = fs.readFile(filePath);
    }
  } catch (err) {
    console.error("[local-folder] addSingleLocalPage read failed", err);
    return;
  }

  const parsed = await parseLocalMarkdownContent(markdown, fallbackTitle, readError);

  // 记录快照
  if (typeof markdown === "string") {
    setLocalMdSnapshot(filePath, markdown);
  }

  // 恢复元数据缓存（如果有）
  const cachedMeta = localPageMetadataCache.get(pageId);

  const now = Date.now();
  const newPage: Page = {
    id: pageId,
    workspaceId: notebookId,
    content: parsed.content,
    isFolder: false,
    isLocked: false,
    isFullWidth: false,
    fontSize: "default",
    fontFamily: "default",
    localFilePath: filePath,
    localFrontmatter: parsed.frontmatter,
    localReadState: parsed.readState,
    localReadError: parsed.readError,
    createdAt: now,
    updatedAt: now,
    ...(cachedMeta?.isFavorite !== undefined && { isFavorite: cachedMeta.isFavorite }),
    ...(cachedMeta?.favoriteOrder !== undefined && { favoriteOrder: cachedMeta.favoriteOrder }),
    ...(cachedMeta?.icon && { icon: cachedMeta.icon }),
    ...(cachedMeta?.isPinned !== undefined && { isPinned: cachedMeta.isPinned }),
    ...(cachedMeta?.pinnedAt !== undefined && { pinnedAt: cachedMeta.pinnedAt }),
  };

  set((state) => ({
    pages: {
      ...state.pages,
      [pageId]: newPage,
    },
  }));
};
