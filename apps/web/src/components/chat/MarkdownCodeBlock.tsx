import { CheckIcon, CodeIcon, CopyIcon, WorkflowIcon, WrapTextIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import {
  hasSpecificPierreIconForFileName,
  syntheticFileNameForLanguageId,
} from "../../pierre-icons";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PierreEntryIcon } from "./PierreEntryIcon";

export function readInitialWordWrapSetting(): boolean {
  return getClientSettings().wordWrap;
}

/** Shared by every markdown chrome action (copy, table export, file-link
 * open, ...) so a failure always logs under one greppable prefix. */
export function reportMarkdownActionFailure<T extends Record<string, unknown>>(
  context: T,
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

/** Toggles a mermaid block between its rendered diagram and its source —
 * owned by the mermaid block, rendered in this shared header so it sits
 * beside copy and wrap like any other code block action. */
export interface MarkdownCodeBlockMermaidToggle {
  readonly showingSource: boolean;
  readonly onToggle: () => void;
}

export function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  theme,
  mermaidToggle,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  mermaidToggle?: MarkdownCodeBlockMermaidToggle;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(readInitialWordWrapSetting);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copyLabel = copied ? "Copied" : "Copy code";
  const toggleLabel = mermaidToggle?.showingSource ? "Show diagram" : "Show source";

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
          {mermaidToggle ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    aria-pressed={mermaidToggle.showingSource}
                    onClick={mermaidToggle.onToggle}
                    aria-label={toggleLabel}
                  />
                }
              >
                {mermaidToggle.showingSource ? (
                  <WorkflowIcon className="size-3" />
                ) : (
                  <CodeIcon className="size-3" />
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
