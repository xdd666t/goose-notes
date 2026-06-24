import { useNotebooks } from "../../../useNotebooks";
import { useTabs } from "../../../useTabs";
import { buildLocalPageId } from "@/lib/local-folder-scanner";
import {
  extractFirstHeadingText,
  sanitizeFilenameSegment,
  splitFilePath,
} from "@/lib/local-title-binding";
import { migrateLocalPageIdMapEntry, toRelativePath } from "@/lib/local-page-idmap";
import { migratePendingLocalSave } from "../../folderSync";
import type { StoreSet, StoreGet } from "../hydrate";
import { cloneLocalPageContent } from "../pageCreate";
import { markSelfMoved } from "./move";
import {
  findDuplicateLocalFileOwner,
  localFilePathExists,
} from "./pathGuards";

function renameLocalPageInStore(
  set: StoreSet,
  get: StoreGet,
  oldPageId: string,
  newPageId: string,
  nextFilePath: string,
): string {
  if (oldPageId === newPageId) {
    set((state) => {
      const page = state.pages[oldPageId];
      if (!page) return state;
      return {
        pages: {
          ...state.pages,
          [oldPageId]: { ...page, localFilePath: nextFilePath },
        },
      };
    });
    return oldPageId;
  }

  set((state) => {
    const page = state.pages[oldPageId];
    if (!page) return state;
    const nextPages = { ...state.pages };
    delete nextPages[oldPageId];
    nextPages[newPageId] = {
      ...page,
      id: newPageId,
      localFilePath: nextFilePath,
    };

    const nextDirty = { ...state.dirtyLocalPageIds };
    if (oldPageId in nextDirty) {
      // 注意：已保存的页面键值为 false 但键仍存在，不能用 `in` 当作"脏"——
      // 否则 rename 后标签页凭空出现"未保存"黄点。只有真 dirty 才转移。
      const wasDirty = nextDirty[oldPageId] === true;
      delete nextDirty[oldPageId];
      if (wasDirty) {
        nextDirty[newPageId] = true;
      }
    }

    return {
      pages: nextPages,
      dirtyLocalPageIds: nextDirty,
      activePageId:
        state.activePageId === oldPageId ? newPageId : state.activePageId,
    };
  });

  // 防抖保存队列里挂在旧 id 上的待写内容迁到新 id，
  // 避免计时器到期后按旧 id 查不到页面、内容丢失且脏标记清不掉。
  migratePendingLocalSave(oldPageId, newPageId, get);

  // tabs 引用同步
  useTabs.setState((state) => ({
    openTabs: state.openTabs.map((tab) =>
      tab.pageId === oldPageId ? { ...tab, pageId: newPageId } : tab,
    ),
  }));

  // notebooks 的 lastActivePage 同步
  const notebooksState = useNotebooks.getState();
  const nextLastActive = { ...notebooksState.lastActivePageByNotebook };
  let changed = false;
  for (const key of Object.keys(nextLastActive)) {
    if (nextLastActive[key] === oldPageId) {
      nextLastActive[key] = newPageId;
      changed = true;
    }
  }
  if (changed) {
    useNotebooks.setState({ lastActivePageByNotebook: nextLastActive });
  }

  return newPageId;
}

async function maybeRenameLocalFileForTitle(
  set: StoreSet,
  get: StoreGet,
  pageId: string,
): Promise<{ pageId: string; collision: boolean }> {
  const page = get().pages[pageId];
  if (!page || !page.localFilePath) return { pageId, collision: false };

  const newTitle = extractFirstHeadingText(page.content);
  if (!newTitle) return { pageId, collision: false };

  const sanitized = sanitizeFilenameSegment(newTitle);
  if (!sanitized) return { pageId, collision: false };

  const { dir, base, ext } = splitFilePath(page.localFilePath);
  if (sanitized === base) return { pageId, collision: false };

  const nextFilePath = `${dir}/${sanitized}${ext}`;

  if (typeof window === "undefined" || !window.gooseFs) {
    return { pageId, collision: false };
  }

  const fs = window.gooseFs;
  const duplicatePage = findDuplicateLocalFileOwner(
    get().pages,
    pageId,
    nextFilePath,
  );
  if (duplicatePage) {
    console.warn(
      "[local-title] rename skipped, target already tracked:",
      { nextFilePath, duplicatePageId: duplicatePage.id },
    );
    return { pageId, collision: true };
  }
  if (await localFilePathExists(fs, nextFilePath)) {
    console.warn(
      "[local-title] rename skipped, target exists:",
      nextFilePath,
    );
    return { pageId, collision: true };
  }

  let renamed: boolean;
  try {
    markSelfMoved(page.localFilePath.replace(/\\/g, "/"));
    markSelfMoved(nextFilePath.replace(/\\/g, "/"));
    renamed = Boolean(
      await Promise.resolve(fs.rename(page.localFilePath, nextFilePath)),
    );
  } catch (err) {
    console.error("[local-title] rename failed:", err);
    return { pageId, collision: false };
  }

  if (!renamed) return { pageId, collision: false };

  const notebook = useNotebooks.getState().notebooks[page.workspaceId];
  const basePath = notebook?.localPath || "";
  const newPageId = buildLocalPageId(page.workspaceId, basePath, nextFilePath);
  const nextPageId = renameLocalPageInStore(
    set,
    get,
    pageId,
    newPageId,
    nextFilePath,
  );

  return { pageId: nextPageId, collision: false };
}

/**
 * 显式重命名 local-folder 页面文件。
 * 由虚拟标题组件在用户提交新名称时调用。
 *
 * @param newBaseName  新文件名（不含扩展名，已由调用方 sanitize）
 * @returns            成功时返回新 pageId；失败时 throw
 */
export async function renameLocalPageFileAction(
  set: StoreSet,
  get: StoreGet,
  pageId: string,
  newBaseName: string,
): Promise<string> {
  const page = get().pages[pageId];
  if (!page || !page.localFilePath) {
    throw new Error("页面不存在或非本地文件夹页面");
  }

  const sanitized = sanitizeFilenameSegment(newBaseName);
  if (!sanitized) {
    throw new Error("文件名不能为空");
  }

  const { dir, base, ext } = splitFilePath(page.localFilePath);
  if (sanitized === base) {
    // 名称未变，无需操作
    return pageId;
  }

  const nextFilePath = `${dir}/${sanitized}${ext}`;

  if (typeof window === "undefined" || !window.gooseFs) {
    throw new Error("文件系统不可用");
  }

  const fs = window.gooseFs;
  const duplicatePage = findDuplicateLocalFileOwner(
    get().pages,
    pageId,
    nextFilePath,
  );
  if (duplicatePage || await localFilePathExists(fs, nextFilePath)) {
    throw new Error(`已存在同名文件：${sanitized}${ext}`);
  }

  let renamed: boolean;
  try {
    markSelfMoved(page.localFilePath.replace(/\\/g, "/"));
    markSelfMoved(nextFilePath.replace(/\\/g, "/"));
    renamed = Boolean(await Promise.resolve(fs.rename(page.localFilePath, nextFilePath)));
  } catch (err) {
    throw new Error(`重命名失败：${(err as Error).message ?? String(err)}`, { cause: err });
  }
  if (!renamed) {
    throw new Error("重命名操作未成功");
  }

  // 迁移快照 Map：旧路径 → 新路径（保持保存前 diff 有效）
  const { getLocalMdSnapshot, setLocalMdSnapshot, deleteLocalMdSnapshot } =
    await import("@/lib/local-md-snapshot");
  const oldSnapshot = getLocalMdSnapshot(page.localFilePath);
  if (oldSnapshot !== undefined) {
    setLocalMdSnapshot(nextFilePath, oldSnapshot);
    deleteLocalMdSnapshot(page.localFilePath);
  }

  // 稳定 id：更新映射表（旧 relativePath → 新 relativePath，stableId 不变），
  // 然后只更新 page 的 localFilePath 字段，id 保持不变。
  const notebook = useNotebooks.getState().notebooks[page.workspaceId];
  const basePath = notebook?.localPath || "";
  const oldRelativePath = toRelativePath(basePath, page.localFilePath);
  const newRelativePath = toRelativePath(basePath, nextFilePath);
  migrateLocalPageIdMapEntry(
    page.workspaceId,
    oldRelativePath,
    newRelativePath,
    pageId,
  );

  // id 不变，仅更新 localFilePath（以及同步 dirtyLocalPageIds 键不需要改变）。
  set((state) => {
    const current = state.pages[pageId];
    if (!current) return state;
    return {
      pages: {
        ...state.pages,
        [pageId]: { ...current, localFilePath: nextFilePath },
      },
    };
  });

  return pageId;
}

export const saveDirtyLocalPageAction = async (
  set: StoreSet,
  get: StoreGet,
  pageId: string,
): Promise<boolean> => {
  const page = get().pages[pageId];
  if (!page) return false;
  if (page.localReadState === "error") return false;

  try {
    // 先让编辑器把最新内容刷进 store。
    window.dispatchEvent(
      new CustomEvent("goose-note:flush-editor", {
        detail: { immediate: true, pageId },
      }),
    );

    // NOTE: 「H1 → 文件名」自动 rename 已停用。
    // H1 不再绑定文件名（见 P0 止血：local-folder 链路重构），
    // maybeRenameLocalFileForTitle 调用被跳过，待虚拟标题方案接管后再重新设计此机制。
    // const { pageId: effectivePageId, collision } =
    //   await maybeRenameLocalFileForTitle(set, get, pageId);
    const effectivePageId = pageId;

    const latest = get().pages[effectivePageId];
    if (!latest) return false;

    const ok = await get().saveLocalPageContent(
      effectivePageId,
      cloneLocalPageContent(latest.content),
    );
    if (ok) {
      set((s) => ({
        dirtyLocalPageIds: { ...s.dirtyLocalPageIds, [effectivePageId]: false },
      }));
    }
    return ok;
  } catch {
    return false;
  }
};
