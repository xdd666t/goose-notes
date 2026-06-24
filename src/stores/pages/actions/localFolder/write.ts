import type { JSONContent } from "@/types";
import { normalizePageContent } from "@/components/editor/utils/blocknote-content";
import {
  extractFrontmatter,
  decodeUnsupportedMarkdownForDisk,
} from "@/lib/markdown-raw-guard";
import { isLocalFolderPage } from "../../persistence";
import {
  isLocalMdUnchanged,
  updateSnapshotAfterWrite,
  applyTrailingNewlineStyle,
  isDiskContentMatchingSnapshot,
  markSelfWrite,
} from "@/lib/local-md-snapshot";
import {
  flushPendingLocalSaveByPageIdInternal,
  flushAllPendingLocalSavesInternal,
} from "../../folderSync";
import type { StoreSet, StoreGet } from "../hydrate";
import { clonePageContent, cloneLocalPageContent } from "../pageCreate";
import { findDuplicateLocalFileOwner } from "./pathGuards";

// FNV-1a 32 位哈希（含长度），用于按内容给图片附件命名以实现去重。
function hashBase64(data: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16) + data.length.toString(36);
}

function mergePageContent(
  base: JSONContent,
  addition: JSONContent,
  opts?: { ensureFirstTitle?: boolean },
): JSONContent {
  const baseBlocks = normalizePageContent(base, opts);
  const additionBlocks = normalizePageContent(addition, opts);
  if (!additionBlocks.length) {
    return baseBlocks;
  }

  const lastBlock = baseBlocks.at(-1);
  const firstAdditionBlock = additionBlocks[0];
  const needsSpacer =
    baseBlocks.length > 0 &&
    lastBlock?.type !== "paragraph" &&
    firstAdditionBlock?.type !== "paragraph";

  return [
    ...baseBlocks,
    ...(needsSpacer ? ([{ type: "paragraph", content: "" }] as JSONContent) : []),
    ...additionBlocks,
  ];
}

export const writePageContentAction = async (
  set: StoreSet,
  get: StoreGet,
  pageId: string,
  content: JSONContent,
  _mode: "replace" = "replace",
): Promise<boolean> => {
  const page = get().pages[pageId];
  if (!page || page.isFolder) return false;

  const isLocal = isLocalFolderPage(page);
  get().updatePage(pageId, {
    content: isLocal ? cloneLocalPageContent(content) : clonePageContent(content),
  });

  if (isLocal) {
    // 程序化写入（AI 等）不走 dirty 队列：直接落盘并清掉 dirty 标记。
    const saved = await get().saveLocalPageContent(
      pageId,
      cloneLocalPageContent(content),
    );
    if (saved) {
      set((s) => ({
        dirtyLocalPageIds: { ...s.dirtyLocalPageIds, [pageId]: false },
      }));
    }
    return saved;
  }

  return true;
};

export const appendPageContentAction = async (
  set: StoreSet,
  get: StoreGet,
  pageId: string,
  content: JSONContent,
): Promise<boolean> => {
  const page = get().pages[pageId];
  if (!page || page.isFolder) return false;

  const isLocal = isLocalFolderPage(page);
  const mergeOpts = isLocal ? { ensureFirstTitle: false } : undefined;
  const mergedContent = mergePageContent(
    isLocal ? cloneLocalPageContent(page.content) : clonePageContent(page.content),
    isLocal ? cloneLocalPageContent(content) : clonePageContent(content),
    mergeOpts,
  );

  return await get().writePageContent(pageId, mergedContent);
};

export const replaceBlockRangeAction = async (
  set: StoreSet,
  get: StoreGet,
  pageId: string,
  startBlockId: string,
  endBlockId: string,
  newBlocks: JSONContent,
): Promise<boolean> => {
  const page = get().pages[pageId];
  if (!page || page.isFolder) return false;

  const sourceContent = page.content as unknown;
  const sourceBlocks = Array.isArray(sourceContent)
    ? (sourceContent as any[])
    : Array.isArray((sourceContent as any)?.content)
      ? ((sourceContent as any).content as any[])
      : null;
  if (!sourceBlocks) return false;

  const startIdx = sourceBlocks.findIndex(
    (block) => block?.id === startBlockId,
  );
  const endIdx = sourceBlocks.findIndex(
    (block) => block?.id === endBlockId,
  );
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return false;

  const replacementBlocks = Array.isArray(newBlocks)
    ? (newBlocks as any[])
    : Array.isArray((newBlocks as any)?.content)
      ? ((newBlocks as any).content as any[])
      : [];
  if (!replacementBlocks.length) return false;

  const isLocal = isLocalFolderPage(page);
  const cloner = isLocal ? cloneLocalPageContent : clonePageContent;
  const clonedSource = cloner(sourceContent as JSONContent) as any[];
  const cloneArr = Array.isArray(clonedSource) ? clonedSource : [];
  const head = cloneArr.slice(0, startIdx);
  const tail = cloneArr.slice(endIdx + 1);
  const replacement = cloner(replacementBlocks as JSONContent).map(
    (block: any) => {
      if (block && typeof block === "object" && "id" in block) {
        const { id: _omit, ...rest } = block;
        void _omit;
        return rest;
      }
      return block;
    },
  );

  const nextContent = [...head, ...replacement, ...tail] as JSONContent;
  return await get().writePageContent(pageId, nextContent);
};

export const saveLocalPageContentAction = async (
  set: StoreSet,
  get: StoreGet,
  pageId: string,
  content: JSONContent,
  options?: { force?: boolean },
): Promise<boolean> => {
  if (typeof window === "undefined" || !window.gooseFs)
    return false;

  const page = get().pages[pageId];
  if (!page) return false;

  const filePath = get().getLocalFilePath(pageId);
  if (!filePath) return false;

  const duplicatePage = findDuplicateLocalFileOwner(get().pages, pageId, filePath);
  if (duplicatePage) {
    console.error("[local-folder] refusing to save duplicate local file path", {
      pageId,
      duplicatePageId: duplicatePage.id,
      filePath,
    });
    window.dispatchEvent(
      new CustomEvent("goose-note:local-file-duplicate", {
        detail: {
          pageId,
          duplicatePageId: duplicatePage.id,
          filePath,
        },
      }),
    );
    return false;
  }

  const processedContent = content;

  const assetsDir = filePath.replace(/[^\/\\]+$/, "") + "assets";

  // 先收集需要落盘的图片，真正有图片要写时才 mkdir——
  // 否则纯打开/flush（内容未变走 diff 跳过）也会在用户目录凭空创建 assets 文件夹。
  const pendingImageWrites: Array<{ imagePath: string; base64Data: string }> = [];

  const processImages = (nodes: any[]) => {
    nodes.forEach((node) => {
      if (
        (node.type === "image" || node.type === "imageResize") &&
        node.attrs?.src?.startsWith("data:image")
      ) {
        const match = node.attrs.src.match(
          /^data:(image\/([a-zA-Z+]+));base64,(.+)$/,
        );
        if (match) {
          const ext = match[2] === "jpeg" ? "jpg" : match[2];
          // 按内容哈希命名以去重：相同图片只落盘一次，避免反复保存产生重复文件。
          const base64Data = match[3];
          const filename = `img_${hashBase64(base64Data)}.${ext}`;
          const imagePath = `${assetsDir}/${filename}`;

          let alreadyExists = false;
          try {
            alreadyExists = window.gooseFs?.exists?.(imagePath) ?? false;
          } catch {}

          if (!alreadyExists) {
            pendingImageWrites.push({ imagePath, base64Data });
          }

          node.attrs.src = `./assets/${filename}`;
        }
      }
      if (node.content) {
        processImages(node.content);
      }
    });
  };

  if (processedContent.content) {
    processImages(processedContent.content);
  }

  if (pendingImageWrites.length > 0) {
    try {
      if (window.gooseFs.mkdir) {
        await window.gooseFs.mkdir(assetsDir);
      }
    } catch {}
    await Promise.all(
      pendingImageWrites.map(({ imagePath, base64Data }) => {
        if (window.gooseFs?.writeFileAsync) {
          return window.gooseFs.writeFileAsync(imagePath, base64Data, "base64");
        }
        return Promise.resolve(window.gooseFs?.writeFile(imagePath, base64Data));
      }),
    );
  }

  const { blocksToMarkdown } = await import("@/lib/export");
  const markdownContent = await blocksToMarkdown(processedContent as any);

  // scanner 抽出 frontmatter 后不入编辑器，保存时由这里 prepend 回去
  // （否则首次保存就把 frontmatter 丢了）
  const finalContent = page.localFrontmatter
    ? `${page.localFrontmatter}\n\n${markdownContent}`
    : markdownContent;

  if (!markdownContent.trim()) {
    let exists = false;
    try { exists = window.gooseFs?.exists(filePath) ?? false; } catch {}

    if (exists) {
      let oldContent: string;
      if (window.gooseFs?.readFileAsync) {
        oldContent = await window.gooseFs.readFileAsync(filePath) || "";
      } else {
        oldContent = window.gooseFs?.readFile(filePath) || "";
      }

      // 判断旧文件是否还有实质 body（去掉 frontmatter 后），避免误判 frontmatter 自身为有效内容
      const { body: oldBody } = extractFrontmatter(oldContent);
      if (oldBody && oldBody.trim().length > 10) {
        console.error("[Data Integrity] Refusing to save empty content.");
        return false;
      }
    }
  }

  // 编辑器表示 → 磁盘表示：解包 goose-raw fence（encodeUnsupportedMarkdownForEditor
  // 的逆操作）。落盘内容绝不能带围栏。此前由 main.tsx 的 gooseFs 写包装器代劳，
  // 守卫清理后 decode 职责收归这里（md 文本写盘唯一路径），diff/快照/写盘三者统一。
  // 再按快照原文还原尾换行风格：blocksToMarkdown 不带尾 \n，不还原会让每次编辑
  // 都丢掉原文件的 POSIX 尾换行，给 git diff 制造噪音。
  const diskContent = applyTrailingNewlineStyle(
    filePath,
    decodeUnsupportedMarkdownForDisk(finalContent),
  );

  // 保存前 diff 兜底：与磁盘快照比较（规范化后），完全相同则跳过写盘。
  // 防止「打开即写盘」——仅 normalize 或 frontmatter 无变化的情况触发的无意义落盘。
  if (isLocalMdUnchanged(filePath, diskContent)) {
    // 内容未变，按成功处理，清除脏标记（如果有的话）。
    set((s) => ({
      dirtyLocalPageIds: { ...s.dirtyLocalPageIds, [pageId]: false },
    }));
    return true;
  }

  // ── 写盘前冲突检查 ──────────────────────────────────────────────────────────
  // 读一次磁盘当前内容，与快照比较（规范化后），不一致 = 外部已改 → 不写盘，触发冲突处理。
  // 这比仅与 store 内容比较更安全：保证不会静默覆盖外部编辑。
  if (!options?.force) {
    try {
      let diskCurrentContent: string | null = null;
      if (window.gooseFs?.readFileStatAsync) {
        const r = await window.gooseFs.readFileStatAsync(filePath);
        diskCurrentContent = r.ok ? (r.content ?? "") : null;
      } else if (window.gooseFs?.readFileStat) {
        const r = window.gooseFs.readFileStat(filePath);
        diskCurrentContent = r.ok ? (r.content ?? "") : null;
      } else if (window.gooseFs?.readFileAsync) {
        diskCurrentContent = await window.gooseFs.readFileAsync(filePath);
      } else if (window.gooseFs?.readFile) {
        diskCurrentContent = window.gooseFs.readFile(filePath);
      }

      if (
        diskCurrentContent !== null &&
        !isDiskContentMatchingSnapshot(filePath, diskCurrentContent)
      ) {
        // 外部已修改磁盘文件 → 触发冲突 UX，不写盘
        window.dispatchEvent(
          new CustomEvent("goose-note:local-file-conflict", {
            detail: { pageId, filePath, source: "pre-save" },
          }),
        );
        return false;
      }
    } catch {
      // 读磁盘失败时放行（网络文件系统等异常情况下不阻断写盘）
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  // 写盘前标记自写：fs.watch 对本次写入触发的 change 事件（自写回声）
  // 由 useLocalFolderWatch 据此忽略，不会误判成外部修改弹冲突提示。
  markSelfWrite(filePath);
  let result: boolean;
  if (window.gooseFs?.writeFileAsync) {
    result = await window.gooseFs.writeFileAsync(filePath, diskContent);
  } else {
    result = window.gooseFs?.writeFile(filePath, diskContent) ?? false;
  }

  if (result) {
    // 落盘成功即清除脏标记（自动保存与显式保存共用此路径）。
    set((s) => ({
      lastSavedAt: Date.now(),
      dirtyLocalPageIds: { ...s.dirtyLocalPageIds, [pageId]: false },
    }));
    // 写盘成功后更新快照为实际写入磁盘的内容，下次变更比较以此为基准。
    updateSnapshotAfterWrite(filePath, diskContent);
  }
  return result;
};

export const flushPendingLocalSaveByPageIdAction = async (
  _set: StoreSet,
  get: StoreGet,
  pageId: string,
) => {
  // saveLocalPageContent 成功时自行清 dirty；失败（含冲突）时不能强清
  await flushPendingLocalSaveByPageIdInternal(pageId, get);
};

export const flushPendingLocalSavesAction = async (
  set: StoreSet,
  get: StoreGet,
) => {
  await flushAllPendingLocalSavesInternal(get);
};

export const isLocalPageDirtyAction = (
  get: StoreGet,
  pageId: string,
): boolean => {
  return Boolean(get().dirtyLocalPageIds[pageId]);
};
