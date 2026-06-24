import { SettingsAppearance } from "./SettingsAppearance";
import { SettingsGeneral } from "./SettingsGeneral";
import { SettingsShortcuts } from "./settings/SettingsShortcuts";
import { SettingsLocalFolder } from "./SettingsLocalFolder";
import { SettingsDataPanel } from "./settings/SettingsDataPanel";
import { SettingsAI } from "./SettingsAI";
import { SettingsScaffold } from "./settings/SettingsScaffold";
import type { SettingsTab, SettingsTabConfig } from "./settings/types";
import { useShallow } from "zustand/react/shallow";
import { useNotebooks, DEFAULT_NOTEBOOK } from "@/stores/useNotebooks";
import { clearLocalPageMetadataCache, usePages } from "@/stores/usePages";
import { useSettings } from "@/stores/useSettings";
import { clearPersistedPages } from "@/lib/storage/pageRepository";
import { clearLegacyStorage } from "@/lib/storage/migrateLegacyStorage";
import { usePersistentDismissState } from "@/hooks/usePersistentDismissState";
import { UToolsAdapter } from "@/lib/utools";
import type { ExportOptions } from "@/lib/export";
import { uToolsStorage as dataStorage } from "@/lib/storage";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SETTINGS_TABS: SettingsTabConfig[] = [
  { id: "general", label: "通用设置", icon: LucideIcons.Settings },
  { id: "shortcuts", label: "快捷键", icon: LucideIcons.Keyboard },
  { id: "local-folder", label: "本地文件夹", icon: LucideIcons.FolderOpen },
  { id: "appearance", label: "外观主题", icon: LucideIcons.Laptop },
  { id: "ai", label: "AI 助手", icon: LucideIcons.Sparkles },
  { id: "data", label: "数据管理", icon: LucideIcons.Database },
];

// 推荐应用数据
const RECOMMENDED_APPS = [
  {
    id: "goose-bookmark",
    name: "鹅的书签",
    url: "https://www.u-tools.cn/plugins/detail/%E9%B9%85%E7%9A%84%E4%B9%A6%E7%AD%BE/",
  },
  {
    id: "goose-billiard",
    name: "鹅的桌球",
    url: "https://www.u-tools.cn/plugins/detail/%E9%B9%85%E7%9A%84%E6%A1%8C%E7%90%83/",
  },
];

const FEEDBACK_URL = "https://wj.qq.com/s2/25958121/2d2e/";
const SETTINGS_APPS_BANNER_ID = "settings:recommended-apps-banner";

const recordPreOverwriteHistory = async (id: string | undefined) => {
  if (!id) return;
  const existingPage = usePages.getState().pages[id];
  if (existingPage && existingPage.content) {
    const oldContent = existingPage.content;
    const oldWorkspaceId = existingPage.workspaceId;
    try {
      const { recordHistorySnapshot } = await import("@/lib/history/snapshot");
      await recordHistorySnapshot({
        pageId: id,
        workspaceId: oldWorkspaceId,
        content: oldContent,
        trigger: "manual",
        isMilestone: true,
        label: "备份覆盖前本地版本",
      });
    } catch (err) {
      console.error("[history] Failed to save pre-overwrite history", err);
    }
  }
};

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const {
    theme,
    setTheme,
    codeStyle,
    setCodeStyle,
    globalEditorFullWidth,
    setGlobalEditorFullWidth,
    tableEvenColumnWidth,
    setTableEvenColumnWidth,
    searchProviders,
    toggleSearchProvider,
    reorderSearchProviders,
    utools,
    ai,
    setOpenSearchInUtools,
    setAIEnabled,
    setAISelectedModelId,
    setAICustomProviderEnabled,
    saveAICustomConfig,
    setUToolsWindowHeight,
    privacy,
    setAutoOpenLastNote,
    showRecentInSearch,
    setShowRecentInSearch,
    closeTabShortcut,
    setCloseTabShortcut,
    searchPanelCloseShortcut,
    setSearchPanelCloseShortcut,
    appShortcuts,
    setAppShortcut,
    resetAppShortcuts,
    customFonts,
    setCustomLabel,
    setCustomFont,
    uiFontSize,
    setUIFontSize,
    hideExpandArrows,
    setHideExpandArrows,
    customActions,
    addCustomAction,
    updateCustomAction,
    removeCustomAction,
    notebookDropdownHoverExpand,
    setNotebookDropdownHoverExpand,
    sidebarClickBehavior,
    setSidebarClickBehavior,
    localFolderExternalEditor,
    setLocalFolderExternalEditor,
  } = useSettings(useShallow((s) => ({
    theme: s.theme,
    setTheme: s.setTheme,
    codeStyle: s.codeStyle,
    setCodeStyle: s.setCodeStyle,
    globalEditorFullWidth: s.globalEditorFullWidth,
    setGlobalEditorFullWidth: s.setGlobalEditorFullWidth,
    tableEvenColumnWidth: s.tableEvenColumnWidth,
    setTableEvenColumnWidth: s.setTableEvenColumnWidth,
    searchProviders: s.searchProviders,
    toggleSearchProvider: s.toggleSearchProvider,
    reorderSearchProviders: s.reorderSearchProviders,
    utools: s.utools,
    ai: s.ai,
    setOpenSearchInUtools: s.setOpenSearchInUtools,
    setAIEnabled: s.setAIEnabled,
    setAISelectedModelId: s.setAISelectedModelId,
    setAICustomProviderEnabled: s.setAICustomProviderEnabled,
    saveAICustomConfig: s.saveAICustomConfig,
    setUToolsWindowHeight: s.setUToolsWindowHeight,
    privacy: s.privacy,
    setAutoOpenLastNote: s.setAutoOpenLastNote,
    showRecentInSearch: s.showRecentInSearch,
    setShowRecentInSearch: s.setShowRecentInSearch,
    closeTabShortcut: s.closeTabShortcut,
    setCloseTabShortcut: s.setCloseTabShortcut,
    searchPanelCloseShortcut: s.searchPanelCloseShortcut,
    setSearchPanelCloseShortcut: s.setSearchPanelCloseShortcut,
    appShortcuts: s.appShortcuts,
    setAppShortcut: s.setAppShortcut,
    resetAppShortcuts: s.resetAppShortcuts,
    customFonts: s.customFonts,
    setCustomLabel: s.setCustomLabel,
    setCustomFont: s.setCustomFont,
    uiFontSize: s.uiFontSize,
    setUIFontSize: s.setUIFontSize,
    hideExpandArrows: s.hideExpandArrows,
    setHideExpandArrows: s.setHideExpandArrows,
    customActions: s.customActions,
    addCustomAction: s.addCustomAction,
    updateCustomAction: s.updateCustomAction,
    removeCustomAction: s.removeCustomAction,
    notebookDropdownHoverExpand: s.notebookDropdownHoverExpand,
    setNotebookDropdownHoverExpand: s.setNotebookDropdownHoverExpand,
    sidebarClickBehavior: s.sidebarClickBehavior,
    setSidebarClickBehavior: s.setSidebarClickBehavior,
    localFolderExternalEditor: s.localFolderExternalEditor,
    setLocalFolderExternalEditor: s.setLocalFolderExternalEditor,
  })));
  const { notebooks } = useNotebooks(useShallow((s) => ({ notebooks: s.notebooks })));
  const { pages } = usePages(useShallow((s) => ({ pages: s.pages })));
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

  useEffect(() => {
    const handleTabChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ tab?: SettingsTab }>;
      if (customEvent.detail?.tab) {
        setActiveTab(customEvent.detail.tab);
      }
    };

    window.addEventListener("goose-note:settings-tab-change", handleTabChange);
    return () => {
      window.removeEventListener("goose-note:settings-tab-change", handleTabChange);
    };
  }, []);

  // 数据管理状态
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [format, setFormat] = useState<ExportOptions["format"]>("md");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetInput, setResetInput] = useState("");
  const { visible: appsBannerVisible, dismiss: dismissAppsBanner } =
    usePersistentDismissState(SETTINGS_APPS_BANNER_ID);

  const notebookList = Object.values(notebooks).filter(
    (n) => n.source !== "local-folder",
  );
  const { createNotebook } = useNotebooks(useShallow((s) => ({ createNotebook: s.createNotebook })));
  const { createPage, updatePage } = usePages(useShallow((s) => ({ createPage: s.createPage, updatePage: s.updatePage })));
  const resetPhrase = "我已知晓风险";
  const canReset = resetInput.trim() === resetPhrase;

  const toggleNotebook = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id],
    );
  };

  const selectAll = () => {
    if (selectedIds.length === notebookList.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(notebookList.map((n) => n.id));
    }
  };

  const handleExport = async () => {
    if (selectedIds.length === 0) return;
    setExporting(true);
    try {
      const { exportNotebooks } = await import("@/lib/export");
      await exportNotebooks(
        {
          format,
          notebookIds: selectedIds,
        },
        notebooks,
        Object.values(pages),
      );
      toast.success("导出成功");
    } catch (err) {
      console.error("Export failed", err);
      toast.error("导出失败", {
        description: "当前仅支持在 uTools 插件内导出，请稍后重试。",
      });
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,.mdzip";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      setImporting(true);
      try {
        let firstWorkspaceId: string | null = null;
        let firstPageId: string | null = null;
        let notebookCount = 0;
        let pageCount = 0;

        const { importNotebooksFromZip } = await import("@/lib/export");
        await importNotebooksFromZip(
          file,
          (name, icon, id) => {
            notebookCount++;
            const newId = createNotebook(name, icon || "BookOpen", true, id);
            if (!firstWorkspaceId) firstWorkspaceId = newId;
            return newId;
          },
          async (data, workspaceId, parentId, id) => {
            pageCount++;
            await recordPreOverwriteHistory(id);
            const pageId = usePages.getState().createPageRecord({
              ...data,
              id,
              workspaceId,
              parentId,
            });
            if (!firstPageId) firstPageId = pageId;
            return pageId;
          },
        );

        const { setActiveNotebook } = useNotebooks.getState();
        const { setActivePage } = usePages.getState();

        if (firstWorkspaceId) setActiveNotebook(firstWorkspaceId);
        if (firstPageId) setActivePage(firstPageId);

        toast.success("导入成功", {
          description: `已恢复 ${notebookCount} 个记事本，共 ${pageCount} 个页面`,
        });
      } catch (err) {
        console.error("Import failed", err);
        toast.error("导入失败", {
          description: "请确保文件是有效的导出 ZIP 包",
        });
      } finally {
        setImporting(false);
      }
    };
    input.click();
  };

  useEffect(() => {
    if (!resetDialogOpen) {
      setResetInput("");
    }
  }, [resetDialogOpen]);

  const handleImportBlob = async (blob: Blob) => {
    setImporting(true);
    try {
      let firstWorkspaceId: string | null = null;
      let firstPageId: string | null = null;
      const { importNotebooksFromZip } = await import("@/lib/export");
      await importNotebooksFromZip(
        blob,
        (name, icon, id) => {
          const newId = createNotebook(name, icon || "BookOpen", true, id);
          if (!firstWorkspaceId) firstWorkspaceId = newId;
          return newId;
        },
        async (data, workspaceId, parentId, id) => {
          await recordPreOverwriteHistory(id);
          const pageId = usePages.getState().createPageRecord({
            ...data,
            id,
            workspaceId,
            parentId,
          });
          if (!firstPageId && workspaceId === firstWorkspaceId) firstPageId = pageId;
          return pageId;
        },
      );
      if (firstWorkspaceId) {
        useNotebooks.setState({ activeNotebookId: firstWorkspaceId });
        if (firstPageId) {
          usePages.setState({ activePageId: firstPageId });
        }
      }
      toast.success("导入成功");
    } catch (err) {
      console.error("Import blob failed", err);
      toast.error("导入失败");
    } finally {
      setImporting(false);
    }
  };

  const handleReset = async (zipBlob?: Blob) => {
    if (!zipBlob && !canReset) return;
    if (zipBlob) {
      // 在完全清除本地数据前，对所有本地非删除页面提取并记录一份覆盖前历史版本
      const localPages = Object.values(usePages.getState().pages).filter((p) => !p.trashedAt);
      try {
        await Promise.all(localPages.map((page) => recordPreOverwriteHistory(page.id)));
      } catch (err) {
        console.error("[history] Failed to backup pre-overwrite history for all pages", err);
      }
    }
    dataStorage.removeItem("goose-note-notebooks");
    clearPersistedPages();
    clearLegacyStorage();
    clearLocalPageMetadataCache();
    if (zipBlob) {
      // 恢复前先清空 Zustand live 内存状态，防止导入数据和当前内存数据混合
      useNotebooks.setState({
        notebooks: {},
        activeNotebookId: null,
        lastActivePageByNotebook: {},
      });
      usePages.setState({
        pages: {},
        activePageId: null,
        pendingNavigatePageId: null,
        expandPageId: null,
        searchHighlightQuery: null,
        searchHighlightPageId: null,
        searchHighlightNonce: 0,
        handledSearchHighlightNonce: 0,
        hydrated: true,
        lastSavedAt: null,
        onboardingCompleted: false,
      });
      try {
        let firstWorkspaceId: string | null = null;
        let firstPageId: string | null = null;
        const { importNotebooksFromZip } = await import("@/lib/export");
        await importNotebooksFromZip(
          zipBlob,
          (name, icon, id) => {
            const newId = createNotebook(name, icon || "BookOpen", true, id);
            if (!firstWorkspaceId) firstWorkspaceId = newId;
            return newId;
          },
          async (data, workspaceId, parentId, id) => {
            await recordPreOverwriteHistory(id);
            const pageId = usePages.getState().createPageRecord({
              ...data,
              id,
              workspaceId,
              parentId,
            });
            if (!firstPageId && workspaceId === firstWorkspaceId) firstPageId = pageId;
            return pageId;
          },
        );
        if (firstWorkspaceId) {
          useNotebooks.setState({ activeNotebookId: firstWorkspaceId });
          if (firstPageId) {
            usePages.setState({ activePageId: firstPageId });
          }
        }
        toast.success("恢复并同步成功");
      } catch (err) {
        console.error("Sync import failed", err);
        toast.error("恢复失败");
      }
    } else {
      const defaultNotebook = {
        id: DEFAULT_NOTEBOOK,
        name: "Note",
        icon: "BookOpen",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      useNotebooks.setState({
        notebooks: { [DEFAULT_NOTEBOOK]: defaultNotebook },
        activeNotebookId: DEFAULT_NOTEBOOK,
        lastActivePageByNotebook: {},
      });
      usePages.setState({
        pages: {},
        activePageId: null,
        pendingNavigatePageId: null,
        expandPageId: null,
        searchHighlightQuery: null,
        searchHighlightPageId: null,
        searchHighlightNonce: 0,
        handledSearchHighlightNonce: 0,
        hydrated: true,
        lastSavedAt: null,
        onboardingCompleted: false,
      });
      setResetDialogOpen(false);
      onOpenChange(false);
      toast.success("重置成功");
    }
  };

  const handleCloseAppsBanner = () => {
    dismissAppsBanner();
  };

  const handleOpenAppUrl = (url: string) => {
    UToolsAdapter.openUrl(url, false);
  };

  return (
    <>
      <DialogShell
        open={open}
        onOpenChange={onOpenChange}
        layout="fullscreen"
        overlayClassName="bg-transparent backdrop-blur-0"
        contentClassName="border-0 bg-[hsl(var(--goose-shell-bg))]"
        bodyClassName="h-full animate-in fade-in duration-200"
      >
        <SettingsScaffold
          activeTab={activeTab}
          onTabChange={setActiveTab}
          tabs={SETTINGS_TABS}
          feedbackBanner={null}
          appsBanner={
            appsBannerVisible ? (
              <div className="relative rounded-[10px] bg-[hsl(var(--goose-selected-bg)/0.62)] p-3">
                <button
                  type="button"
                  onClick={handleCloseAppsBanner}
                  className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted/70 hover:text-foreground"
                  aria-label="关闭推荐应用"
                >
                  <LucideIcons.X className="h-3 w-3" />
                </button>
                <p className="mb-2 pr-4 text-xs font-medium text-muted-foreground">
                  探索更多应用
                </p>
                <div className="space-y-1">
                  {RECOMMENDED_APPS.map((app) => (
                    <Button
                      key={app.id}
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleOpenAppUrl(app.url)}
                      className="h-auto w-full justify-start gap-2 rounded-[10px] px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-[var(--goose-interactive-hover)] hover:text-foreground"
                    >
                      <span className="flex-1 truncate">{app.name}</span>
                      <ExternalLink className="h-3 w-3 shrink-0 opacity-50" />
                    </Button>
                  ))}
                </div>
              </div>
            ) : null
          }
        >
          {activeTab === "general" && (
            <div className="space-y-4">
              <SettingsGeneral
                searchProviders={searchProviders}
                toggleSearchProvider={toggleSearchProvider}
                reorderSearchProviders={reorderSearchProviders}
                openSearchInUtools={utools.openSearchInUtools}
                setOpenSearchInUtools={setOpenSearchInUtools}
                windowHeight={utools.windowHeight ?? 600}
                setWindowHeight={setUToolsWindowHeight}
                autoOpenLastNote={privacy.autoOpenLastNote}
                setAutoOpenLastNote={setAutoOpenLastNote}
                showRecentInSearch={showRecentInSearch}
                setShowRecentInSearch={setShowRecentInSearch}
                notebookDropdownHoverExpand={notebookDropdownHoverExpand}
                setNotebookDropdownHoverExpand={setNotebookDropdownHoverExpand}
                sidebarClickBehavior={sidebarClickBehavior}
                setSidebarClickBehavior={setSidebarClickBehavior}
                customActions={customActions}
                addCustomAction={addCustomAction}
                updateCustomAction={updateCustomAction}
                removeCustomAction={removeCustomAction}
              />
            </div>
          )}

          {activeTab === "shortcuts" && (
            <div>
              <SettingsShortcuts
                closeTabShortcut={closeTabShortcut}
                setCloseTabShortcut={setCloseTabShortcut}
                searchPanelCloseShortcut={searchPanelCloseShortcut}
                setSearchPanelCloseShortcut={setSearchPanelCloseShortcut}
                appShortcuts={appShortcuts}
                setAppShortcut={setAppShortcut}
                resetAppShortcuts={resetAppShortcuts}
              />
            </div>
          )}

          {activeTab === "local-folder" && (
            <div>
              <SettingsLocalFolder
                localFolderExternalEditor={localFolderExternalEditor}
                setLocalFolderExternalEditor={setLocalFolderExternalEditor}
              />
            </div>
          )}

          {activeTab === "appearance" && (
            <div>
              <SettingsAppearance
                theme={theme}
                setTheme={setTheme}
                codeStyle={codeStyle}
                setCodeStyle={setCodeStyle}
                globalEditorFullWidth={globalEditorFullWidth}
                setGlobalEditorFullWidth={setGlobalEditorFullWidth}
                tableEvenColumnWidth={tableEvenColumnWidth}
                setTableEvenColumnWidth={setTableEvenColumnWidth}
                customFonts={customFonts}
                setCustomLabel={setCustomLabel}
                setCustomFont={setCustomFont}
                uiFontSize={uiFontSize}
                setUIFontSize={setUIFontSize}
                hideExpandArrows={hideExpandArrows}
                setHideExpandArrows={setHideExpandArrows}
              />
            </div>
          )}

          {activeTab === "ai" && (
            <div>
              <SettingsAI
                ai={ai}
                enabled={ai.enabled}
                setEnabled={setAIEnabled}
                selectedModelId={ai.selectedModelId}
                setSelectedModelId={setAISelectedModelId}
                setCustomProviderEnabled={setAICustomProviderEnabled}
                saveCustomConfig={saveAICustomConfig}
              />
            </div>
          )}

          {activeTab === "data" && (
            <SettingsDataPanel
              importing={importing}
              onImport={handleImport}
              selectedIds={selectedIds}
              notebookList={notebookList}
              onToggleNotebook={toggleNotebook}
              onSelectAll={selectAll}
              format={format}
              onFormatChange={setFormat}
              exporting={exporting}
              onExport={handleExport}
              onOpenResetDialog={() => setResetDialogOpen(true)}
              onImportBlob={handleImportBlob}
              onResetAndImport={handleReset}
            />
          )}
        </SettingsScaffold>
      </DialogShell>

      <DialogShell
        open={resetDialogOpen}
        onOpenChange={setResetDialogOpen}
        layout="center"
        title="确认重置所有数据？"
        description="这将永久删除所有记事本和页面"
        contentClassName="max-w-md"
        bodyClassName="px-6 pb-6"
      >
        <div className="mb-5 mt-1 space-y-3">
          <div className="text-xs text-muted-foreground select-none">
            请输入以下短语以确认重置：
            <code className="ml-1 select-text font-semibold text-foreground">
              {resetPhrase}
            </code>
          </div>
          <Input
            id="reset-all"
            value={resetInput}
            onChange={(e) => setResetInput(e.target.value)}
            placeholder={resetPhrase}
            className="h-9 w-full text-sm"
            autoFocus
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setResetDialogOpen(false)}
            className="flex-1"
          >
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => handleReset()}
            disabled={!canReset}
            className="flex-1"
          >
            确认重置
          </Button>
        </div>
      </DialogShell>
    </>
  );
}
