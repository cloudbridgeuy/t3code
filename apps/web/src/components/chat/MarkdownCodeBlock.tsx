import {
  CheckIcon,
  CodeIcon,
  CopyIcon,
  ShrinkIcon,
  UnfoldHorizontalIcon,
  WorkflowIcon,
  WrapTextIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import {
  hasSpecificPierreIconForFileName,
  syntheticFileNameForLanguageId,
} from "../../pierre-icons";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  markdownCodeBlockActions,
  type MermaidChromeMode,
  type MermaidSizeMode,
} from "./mermaidBlock.logic";
import { PierreEntryIcon } from "./PierreEntryIcon";

export function readInitialWordWrapSetting(): boolean {
  return getClientSettings().wordWrap;
}

/** Shared by every markdown chrome action (copy, table export, file-link
 * open, ...) so a failure always logs under one greppable prefix. */
export interface MarkdownActionFailureContext {
  readonly operation: string;
  readonly target?: string;
  readonly format?: "markdown" | "csv";
  readonly language?: string;
  readonly fenceTitle?: string;
  readonly copyTarget?: string;
}

export function reportMarkdownActionFailure(
  context: MarkdownActionFailureContext,
  cause: unknown,
): void {
  console.error("[chat-markdown] action failed", context, cause);
}

/**
 * Filename titles render icon + text; language-only titles render just the
 * icon (redundant next to its own name) and fall back to the language text
 * when no specific icon exists or it fails to load.
 */
function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
  theme,
}: {
  fenceTitle: string | null;
  language: string;
  theme: "light" | "dark";
}) {
  if (fenceTitle) {
    return (
      <>
        <PierreEntryIcon pathValue={fenceTitle} kind="file" theme={theme} className="size-3.5" />
        <span className="truncate">{fenceTitle}</span>
      </>
    );
  }

  const fileName = syntheticFileNameForLanguageId(language);
  if (!hasSpecificPierreIconForFileName(fileName)) {
    return <span className="truncate">{language}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 rounded-sm" aria-label={`Language: ${language}`} />
        }
      >
        <PierreEntryIcon pathValue={fileName} kind="file" theme={theme} className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{language}</TooltipPopup>
    </Tooltip>
  );
}

/** Owned by the mermaid block, rendered in this shared header so mermaid's
 * actions sit beside copy like any other code block action. `mode` picks
 * which of the two chrome layouts renders (see `markdownCodeBlockActions`);
 * `onToggleMode` switches between source and diagram, `sizeMode`/
 * `onSizeModeChange` drive the diagram-mode fit/natural control. */
export interface MarkdownCodeBlockMermaidChrome {
  readonly mode: MermaidChromeMode;
  readonly onToggleMode: () => void;
  readonly sizeMode: MermaidSizeMode;
  readonly onSizeModeChange: (sizeMode: MermaidSizeMode) => void;
}

export function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  theme,
  mermaid,
  children,
  ref,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  mermaid?: MarkdownCodeBlockMermaidChrome;
  children: ReactNode;
  /** Lets a caller (the mermaid block) observe this block's own root node
   * rather than wrapping it in another element — this div is already a
   * stable box present across every mermaid view branch, and React 19
   * function components accept `ref` as a plain prop. */
  ref?: Ref<HTMLDivElement>;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(readInitialWordWrapSetting);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actions = markdownCodeBlockActions(mermaid?.mode);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copyLabel = copied ? "Copied" : "Copy code";
  const toggleLabel = mermaid?.mode === "diagram" ? "Show source" : "Show diagram";
  const sizeLabel = mermaid?.sizeMode === "natural" ? "Fit to width" : "Show natural size";

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure(
          {
            operation: "copy-code-block",
            language,
            ...(fenceTitle ? { fenceTitle } : {}),
          },
          cause,
        );
      });
  }, [code, fenceTitle, language]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      ref={ref}
      className="chat-markdown-codeblock border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div className="chat-markdown-codeblock-header select-none">
        <span className="chat-markdown-codeblock-title">
          <MarkdownCodeBlockTitleContent
            fenceTitle={fenceTitle}
            language={language}
            theme={theme}
          />
        </span>
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Code block actions">
          {actions.includes("mermaid-size") && mermaid ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    aria-pressed={mermaid.sizeMode === "natural"}
                    onClick={() =>
                      mermaid.onSizeModeChange(mermaid.sizeMode === "fit" ? "natural" : "fit")
                    }
                    aria-label={sizeLabel}
                  />
                }
              >
                {mermaid.sizeMode === "natural" ? (
                  <ShrinkIcon className="size-3" />
                ) : (
                  <UnfoldHorizontalIcon className="size-3" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="top">{sizeLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
          {actions.includes("wrap") ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    aria-pressed={wrapped}
                    onClick={() => setWrapped((value) => !value)}
                    aria-label={wrapLabel}
                  />
                }
              >
                <WrapTextIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
          {actions.includes("mermaid-toggle") && mermaid ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    aria-pressed={mermaid.mode === "source"}
                    onClick={mermaid.onToggleMode}
                    aria-label={toggleLabel}
                  />
                }
              >
                {mermaid.mode === "diagram" ? (
                  <CodeIcon className="size-3" />
                ) : (
                  <WorkflowIcon className="size-3" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="top">{toggleLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  onClick={handleCopy}
                  aria-label={copyLabel}
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      {children}
    </div>
  );
}
