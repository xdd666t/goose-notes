import type { Page } from "@/types";

/** 统一本地路径比较口径，避免斜杠差异导致重复路径漏判。 */
export function normalizeLocalFilePathKey(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

/**
 * 查找是否已有另一个页面指向同一个本地文件。
 * 重命名提交和内容保存都会调用它：前者用于拦截同名目标，后者作为写盘前兜底。
 */
export function findDuplicateLocalFileOwner(
  pages: Record<string, Page>,
  pageId: string,
  filePath: string,
): Page | null {
  const targetKey = normalizeLocalFilePathKey(filePath);
  return (
    Object.values(pages).find(
      (candidate) =>
        candidate.id !== pageId &&
        !candidate.isFolder &&
        candidate.localFilePath &&
        normalizeLocalFilePathKey(candidate.localFilePath) === targetKey,
    ) ?? null
  );
}

/** 优先使用异步 exists，兼容只提供同步 exists 的 gooseFs 实现。 */
export async function localFilePathExists(
  fs: GooseFs,
  filePath: string,
): Promise<boolean> {
  try {
    if (fs.existsAsync) {
      return await fs.existsAsync(filePath);
    }
    return fs.exists?.(filePath) ?? false;
  } catch {
    return false;
  }
}
