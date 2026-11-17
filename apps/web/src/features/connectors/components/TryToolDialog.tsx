import type { McpToolStatus } from '@cortecho/shared';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { isApiError } from '@/lib/api-client.ts';
import { useTryTool } from '../api/connectors.mutations.ts';

/** A small example object from the tool's JSON Schema, so Try starts useful. */
export function exampleArguments(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const result: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    result[key] = exampleValue(property);
  }
  return result;
}

function exampleValue(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case 'string':
      return schema.format === 'date-time' ? new Date().toISOString() : '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return exampleArguments(schema);
    default:
      return null;
  }
}

/**
 * Run one tool from the UI. Arguments are raw JSON (works for every schema,
 * including nested anyOf/$ref ones) with an example prefilled. A write tool
 * needs an explicit tick: the same safety rule as the voice path, minus the
 * spoken yes.
 */
export function TryToolDialog({
  connectorId,
  tool,
  open,
  onOpenChange,
}: {
  connectorId: number;
  tool: McpToolStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tryTool = useTryTool(connectorId);
  const [text, setText] = useState(() => JSON.stringify(exampleArguments(tool.inputSchema), null, 2));
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const write = tool.annotations.readOnlyHint !== true || tool.annotations.destructiveHint === true;

  function run() {
    setError(null);
    let args: unknown;
    try {
      args = text.trim() === '' ? {} : JSON.parse(text);
    } catch {
      setError('The arguments are not valid JSON.');
      return;
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      setError('The arguments must be a JSON object.');
      return;
    }
    tryTool.mutate(
      { name: tool.name, args: args as Record<string, unknown>, confirm },
      {
        onError: (error) => {
          if (isApiError(error)) setError(error.fields._root ?? error.message);
          else setError(error.message);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Try {tool.title || tool.name}</DialogTitle>
          <DialogDescription>
            Same timeout and size limit as a voice call. The result is not spoken and the turn history is not
            changed.
          </DialogDescription>
        </DialogHeader>

        {tool.description && <p className="text-sm text-muted-foreground">{tool.description}</p>}

        {write && (
          <Alert>
            <AlertTitle>This tool changes something</AlertTitle>
            <AlertDescription>Tick the box below to confirm before running it.</AlertDescription>
          </Alert>
        )}

        <div className="space-y-1.5">
          <Label htmlFor={`try-args-${tool.id}`}>Arguments (JSON object)</Label>
          <Textarea
            id={`try-args-${tool.id}`}
            rows={8}
            spellCheck={false}
            className="font-mono text-xs"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}
        </div>

        {write && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(event) => setConfirm(event.target.checked)}
              className="size-4 accent-primary"
            />
            I understand this changes something.
          </label>
        )}

        {tryTool.data && (
          <div className="space-y-1 rounded-lg border p-3">
            <p className="text-xs font-medium text-muted-foreground">
              {tryTool.data.ok ? 'Result' : 'Error'} · {tryTool.data.durationMs} ms
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{tryTool.data.text}</pre>
          </div>
        )}
        {tryTool.isError && !error && <p className="text-sm text-destructive">{tryTool.error.message}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={run} disabled={tryTool.isPending || (write && !confirm) || tool.policy === 'off'}>
            {tryTool.isPending ? 'Running…' : 'Run tool'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
