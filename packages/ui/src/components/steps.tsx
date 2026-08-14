import { useMemo, useState } from 'react';
import type { ExtractionRule, Step, StepKind, Target, ValidationIssue } from '@flowcase/core/model';
import { STEP_CATALOG, STEP_GROUPS, createStep, describeCandidate, summarizeStep } from '@flowcase/core/model';
import { appendChild, insertStep, moveStep, removeStep, updateStep } from '../stepTree.js';
import { Badge, Button, Card, Field, Input, Modal, Select, Textarea } from '../ui.js';

interface StepListProps {
  steps: Step[];
  issues: ValidationIssue[];
  dataSetNames: string[];
  snippets: Array<{ id: string; name: string }>;
  onChange: (steps: Step[]) => void;
}

export function StepList({ steps, issues, dataSetNames, snippets, onChange }: StepListProps) {
  const [expanded, setExpanded] = useState<string>();
  const [adding, setAdding] = useState<{ afterId?: string; groupId?: string } | undefined>();

  const add = (kind: StepKind): void => {
    const step = createStep(kind);

    if (adding?.groupId) {
      onChange(appendChild(steps, adding.groupId, step));
    } else {
      onChange(insertStep(steps, step, adding?.afterId));
    }

    setExpanded(step.id);
    setAdding(undefined);
  };

  return (
    <div className="flex flex-col gap-2">
      {steps.length === 0 && (
        <p className="rounded-md border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
          No steps yet. Add one below, or record them by clicking through your app.
        </p>
      )}

      <StepNodes
        steps={steps}
        depth={0}
        issues={issues}
        dataSetNames={dataSetNames}
        snippets={snippets}
        allSteps={steps}
        expanded={expanded}
        setExpanded={setExpanded}
        onChange={onChange}
        onAddAfter={(afterId) => setAdding({ afterId })}
        onAddChild={(groupId) => setAdding({ groupId })}
      />

      <div>
        <Button variant="primary" size="sm" onClick={() => setAdding({})}>
          + Add step
        </Button>
      </div>

      {adding && <AddStepModal onPick={add} onClose={() => setAdding(undefined)} />}
    </div>
  );
}

interface StepNodesProps extends Omit<StepListProps, 'steps'> {
  steps: Step[];
  depth: number;
  allSteps: Step[];
  expanded: string | undefined;
  setExpanded: (id: string | undefined) => void;
  onAddAfter: (afterId: string) => void;
  onAddChild: (groupId: string) => void;
}

function StepNodes(props: StepNodesProps) {
  const { steps, depth, allSteps, expanded, setExpanded, onChange } = props;

  return (
    <>
      {steps.map((step, index) => {
        const stepIssues = props.issues.filter((issue) => issue.stepId === step.id);
        const isOpen = expanded === step.id;

        return (
          <div key={step.id} style={{ marginLeft: depth * 20 }}>
            <Card className={stepIssues.some((i) => i.severity === 'error') ? 'border-red-500/40' : ''}>
              <div className="flex items-center gap-2 px-2 py-1.5">
                <span className="w-6 text-right text-[11px] text-muted">{index + 1}</span>

                <input
                  type="checkbox"
                  checked={step.enabled}
                  onChange={(event) =>
                    onChange(updateStep(allSteps, step.id, (s) => ({ ...s, enabled: event.target.checked })))
                  }
                  aria-label="Enabled"
                  title={step.enabled ? 'Step runs' : 'Step is skipped'}
                />

                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? undefined : step.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <Badge tone={STEP_CATALOG[step.kind]?.isAssertion ? 'blue' : 'neutral'}>
                    {STEP_CATALOG[step.kind]?.label ?? step.kind}
                  </Badge>
                  <span className={`truncate text-sm ${step.enabled ? '' : 'text-muted line-through'}`}>
                    {summarizeStep(step)}
                  </span>
                  {step.repeat && <Badge tone="purple">repeat</Badge>}
                  {step.onFailure === 'soft' && <Badge tone="amber">soft</Badge>}
                  {step.onFailure === 'ignore' && <Badge>optional</Badge>}
                  {step.extract.length > 0 && <Badge tone="green">captures</Badge>}
                  {step.note && <span title={step.note}>💬</span>}
                </button>

                <div className="flex items-center gap-0.5">
                  <Button size="sm" variant="ghost" title="Move up" onClick={() => onChange(moveStep(allSteps, step.id, -1))}>
                    ↑
                  </Button>
                  <Button size="sm" variant="ghost" title="Move down" onClick={() => onChange(moveStep(allSteps, step.id, 1))}>
                    ↓
                  </Button>
                  {step.kind === 'group' && (
                    <Button size="sm" variant="ghost" title="Add step inside" onClick={() => props.onAddChild(step.id)}>
                      +↳
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" title="Add step below" onClick={() => props.onAddAfter(step.id)}>
                    +
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    title="Delete step"
                    onClick={() => onChange(removeStep(allSteps, step.id))}
                  >
                    ✕
                  </Button>
                </div>
              </div>

              {isOpen && (
                <StepEditor
                  step={step}
                  issues={stepIssues}
                  dataSetNames={props.dataSetNames}
                  snippets={props.snippets}
                  onChange={(next) => onChange(updateStep(allSteps, step.id, () => next))}
                />
              )}
            </Card>

            {step.children.length > 0 && (
              <div className="mt-2 flex flex-col gap-2">
                <StepNodes {...props} steps={step.children} depth={depth + 1} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function StepEditor({
  step,
  issues,
  dataSetNames,
  snippets,
  onChange,
}: {
  step: Step;
  issues: ValidationIssue[];
  dataSetNames: string[];
  snippets: Array<{ id: string; name: string }>;
  onChange: (step: Step) => void;
}) {
  const definition = STEP_CATALOG[step.kind];
  const set = (patch: Partial<Step>): void => onChange({ ...step, ...patch });

  return (
    <div className="flex flex-col gap-3 border-t border-line bg-canvas/50 px-3 py-3">
      <p className="text-xs text-muted">{definition?.description}</p>

      {issues.map((issue, index) => (
        <p
          key={index}
          className={`text-xs ${issue.severity === 'error' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}
        >
          {issue.message}
        </p>
      ))}

      {definition?.needsTarget && (
        <TargetEditor target={step.target} onChange={(target) => set({ target })} />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {definition?.value && (
          <Field label={definition.value.label} hint={definition.value.help}>
            {step.kind === 'snippet' ? (
              <Select value={step.snippetId ?? ''} onChange={(event) => set({ snippetId: event.target.value })}>
                <option value="">Choose a snippet…</option>
                {snippets.map((snippet) => (
                  <option key={snippet.id} value={snippet.id}>
                    {snippet.name}
                  </option>
                ))}
              </Select>
            ) : definition.value.kind === 'loadState' ? (
              <Select value={step.value ?? ''} onChange={(event) => set({ value: event.target.value })}>
                <option value="load">load</option>
                <option value="domcontentloaded">domcontentloaded</option>
                <option value="networkidle">networkidle</option>
              </Select>
            ) : definition.value.kind === 'multiline' ? (
              <Textarea rows={3} value={step.value ?? ''} onChange={(event) => set({ value: event.target.value })} />
            ) : (
              <Input
                value={step.value ?? ''}
                placeholder={definition.value.placeholder ?? ''}
                onChange={(event) => set({ value: event.target.value })}
              />
            )}
          </Field>
        )}

        {definition?.value2 && (
          <Field label={definition.value2.label}>
            <Input
              value={step.value2 ?? ''}
              placeholder={definition.value2.placeholder ?? ''}
              onChange={(event) => set({ value2: event.target.value })}
            />
          </Field>
        )}

        {definition?.supportsMatcher && (
          <Field label="Comparison">
            <Select value={step.matcher} onChange={(event) => set({ matcher: event.target.value as Step['matcher'] })}>
              <option value="contains">contains</option>
              <option value="equals">equals exactly</option>
              <option value="startsWith">starts with</option>
              <option value="endsWith">ends with</option>
              <option value="notContains">does not contain</option>
              <option value="regex">matches regular expression</option>
            </Select>
          </Field>
        )}

        <Field label="If this step fails">
          <Select value={step.onFailure} onChange={(event) => set({ onFailure: event.target.value as Step['onFailure'] })}>
            <option value="fail">Stop the test</option>
            <option value="soft">Record it and carry on (soft)</option>
            <option value="ignore">Ignore it entirely (optional step)</option>
          </Select>
        </Field>

        <Field label="Timeout (ms)" hint="Blank uses the test default.">
          <Input
            type="number"
            value={step.timeoutMs ?? ''}
            onChange={(event) =>
              set({ timeoutMs: event.target.value === '' ? undefined : Number(event.target.value) })
            }
          />
        </Field>

        <Field label="Retry attempts" hint="1 means no retry.">
          <Input
            type="number"
            min={1}
            value={step.retry?.attempts ?? ''}
            onChange={(event) =>
              set({
                retry:
                  event.target.value === ''
                    ? undefined
                    : { attempts: Number(event.target.value), delayMs: step.retry?.delayMs ?? 500, backoff: step.retry?.backoff ?? 'fixed' },
              })
            }
          />
        </Field>
      </div>

      <RepeatEditor step={step} dataSetNames={dataSetNames} onChange={onChange} />

      <ExtractEditor rules={step.extract} onChange={(extract) => set({ extract })} />

      <Field label="Note" hint="Visible in the editor and the run report. Never affects execution.">
        <Textarea
          rows={2}
          value={step.note ?? ''}
          placeholder="Why this step exists, or what to watch out for…"
          onChange={(event) => set({ note: event.target.value })}
        />
      </Field>
    </div>
  );
}

function RepeatEditor({
  step,
  dataSetNames,
  onChange,
}: {
  step: Step;
  dataSetNames: string[];
  onChange: (step: Step) => void;
}) {
  const repeat = step.repeat;

  if (!repeat) {
    return (
      <div>
        <Button
          size="sm"
          onClick={() =>
            onChange({
              ...step,
              repeat: {
                mode: 'fixed',
                count: 2,
                max: 100,
                indexVariable: '_index',
                itemVariable: 'row',
                stopOnFailure: true,
              },
            })
          }
        >
          + Repeat this step
        </Button>
      </div>
    );
  }

  const set = (patch: Partial<NonNullable<Step['repeat']>>): void =>
    onChange({ ...step, repeat: { ...repeat, ...patch } });

  return (
    <Card className="bg-canvas/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium">Repeat</span>
        <Button size="sm" variant="danger" onClick={() => onChange({ ...step, repeat: undefined })}>
          Remove
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="How many times">
          <Select value={repeat.mode} onChange={(event) => set({ mode: event.target.value as typeof repeat.mode })}>
            <option value="fixed">A fixed number of times</option>
            <option value="variable">As many times as a variable says</option>
            <option value="data">Once per row of a data set</option>
            <option value="while">Until an element appears or disappears</option>
          </Select>
        </Field>

        {repeat.mode === 'fixed' && (
          <Field label="Count">
            <Input type="number" min={0} value={repeat.count ?? 0} onChange={(event) => set({ count: Number(event.target.value) })} />
          </Field>
        )}

        {repeat.mode === 'variable' && (
          <Field label="Variable holding the count">
            <Input value={repeat.countVariable ?? ''} placeholder="lineItemCount" onChange={(event) => set({ countVariable: event.target.value })} />
          </Field>
        )}

        {repeat.mode === 'data' && (
          <Field label="Data set">
            <Select value={repeat.dataSet ?? ''} onChange={(event) => set({ dataSet: event.target.value })}>
              <option value="">Choose a data set…</option>
              {dataSetNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {repeat.mode === 'while' && (
          <Field label="Condition">
            <Select value={repeat.condition ?? 'visible'} onChange={(event) => set({ condition: event.target.value as 'visible' | 'hidden' })}>
              <option value="visible">While the element is visible</option>
              <option value="hidden">While the element is hidden</option>
            </Select>
          </Field>
        )}

        <Field label="Iteration number variable" hint="Use it as {{_index}} inside the step.">
          <Input value={repeat.indexVariable} onChange={(event) => set({ indexVariable: event.target.value })} />
        </Field>

        {repeat.mode === 'data' && (
          <Field label="Row variable" hint="Reference columns as {{row.column}}.">
            <Input value={repeat.itemVariable} onChange={(event) => set({ itemVariable: event.target.value })} />
          </Field>
        )}

        {(repeat.mode === 'variable' || repeat.mode === 'while') && (
          <Field label="Safety limit" hint="Stops a bad value looping forever.">
            <Input type="number" min={1} value={repeat.max} onChange={(event) => set({ max: Number(event.target.value) })} />
          </Field>
        )}
      </div>

      <label className="mt-2 flex items-center gap-2 text-xs">
        <input type="checkbox" checked={repeat.stopOnFailure} onChange={(event) => set({ stopOnFailure: event.target.checked })} />
        Stop repeating after a failed iteration
      </label>
    </Card>
  );
}

function ExtractEditor({
  rules,
  onChange,
}: {
  rules: ExtractionRule[];
  onChange: (rules: ExtractionRule[]) => void;
}) {
  const update = (index: number, patch: Partial<ExtractionRule>): void =>
    onChange(rules.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)));

  return (
    <Card className="bg-canvas/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium">Capture values for later steps</span>
        <Button
          size="sm"
          onClick={() =>
            onChange([
              ...rules,
              { name: '', from: 'url', group: 1, scope: 'run', required: true } as ExtractionRule,
            ])
          }
        >
          + Capture a value
        </Button>
      </div>

      {rules.length === 0 && (
        <p className="text-xs text-muted">
          Pull an id out of the URL, the page, or an API response and reuse it as {'{{variable}}'} — including in
          tests that depend on this one.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {rules.map((rule, index) => (
          <div key={index} className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-2">
            <Field label="Variable name">
              <Input value={rule.name} placeholder="orderId" onChange={(event) => update(index, { name: event.target.value })} />
            </Field>

            <Field label="Read it from">
              <Select value={rule.from} onChange={(event) => update(index, { from: event.target.value as ExtractionRule['from'] })}>
                <option value="url">The page URL</option>
                <option value="text">An element's text</option>
                <option value="attribute">An element's attribute</option>
                <option value="inputValue">A field's value</option>
                <option value="title">The page title</option>
                <option value="response">An API response</option>
                <option value="storage">Local/session storage or a cookie</option>
                <option value="count">A count of matching elements</option>
                <option value="literal">A fixed value</option>
              </Select>
            </Field>

            {rule.from === 'attribute' && (
              <Field label="Attribute">
                <Input value={rule.attribute ?? ''} placeholder="href" onChange={(event) => update(index, { attribute: event.target.value })} />
              </Field>
            )}

            {rule.from === 'response' && (
              <>
                <Field label="Request URL pattern">
                  <Input value={rule.urlPattern ?? ''} placeholder="**/api/orders" onChange={(event) => update(index, { urlPattern: event.target.value })} />
                </Field>
                <Field label="Path into the JSON" hint="Example: data.order.id">
                  <Input value={rule.jsonPath ?? ''} onChange={(event) => update(index, { jsonPath: event.target.value })} />
                </Field>
              </>
            )}

            {rule.from === 'storage' && (
              <>
                <Field label="Key">
                  <Input value={rule.storageKey ?? ''} onChange={(event) => update(index, { storageKey: event.target.value })} />
                </Field>
                <Field label="Where">
                  <Select value={rule.storageType ?? 'local'} onChange={(event) => update(index, { storageType: event.target.value as 'local' | 'session' | 'cookie' })}>
                    <option value="local">localStorage</option>
                    <option value="session">sessionStorage</option>
                    <option value="cookie">cookie</option>
                  </Select>
                </Field>
              </>
            )}

            {rule.from === 'literal' && (
              <Field label="Value">
                <Input value={rule.literal ?? ''} onChange={(event) => update(index, { literal: event.target.value })} />
              </Field>
            )}

            {(rule.from === 'text' || rule.from === 'attribute' || rule.from === 'inputValue' || rule.from === 'count') && (
              <div className="sm:col-span-2">
                <TargetEditor target={rule.target} onChange={(target) => update(index, { target })} />
              </div>
            )}

            <Field label="Narrow with a regular expression" hint="Optional. Example: /orders/(\d+)">
              <Input value={rule.pattern ?? ''} onChange={(event) => update(index, { pattern: event.target.value })} />
            </Field>

            <Field label="Visible to">
              <Select value={rule.scope} onChange={(event) => update(index, { scope: event.target.value as 'run' | 'test' })}>
                <option value="run">This run, including dependent tests</option>
                <option value="test">Only this test</option>
              </Select>
            </Field>

            <div className="flex items-center justify-between sm:col-span-2">
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={rule.required} onChange={(event) => update(index, { required: event.target.checked })} />
                Fail the step if nothing is captured
              </label>
              <Button size="sm" variant="danger" onClick={() => onChange(rules.filter((_, position) => position !== index))}>
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Shows the element a step acts on, and every backup selector the recorder found.
 * Promoting a different candidate to primary is the manual counterpart to the
 * automatic healing the engine does at run time.
 */
export function TargetEditor({
  target,
  onChange,
}: {
  target: Target | undefined;
  onChange: (target: Target) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!target) {
    return (
      <div className="rounded-md border border-dashed border-line px-3 py-2 text-xs text-muted">
        No element selected. Record this step, or add a CSS selector manually.
        <Button
          size="sm"
          className="ml-2"
          onClick={() =>
            onChange({
              candidates: [{ engine: 'css', value: '', score: 40, source: 'manual' }],
              primaryIndex: 0,
              frame: [],
              inShadowDom: false,
            })
          }
        >
          Add selector
        </Button>
      </div>
    );
  }

  const primary = target.candidates[target.primaryIndex];

  return (
    <div className="rounded-md border border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Element</span>
        <span className="truncate font-mono text-xs">{target.description ?? (primary ? describeCandidate(primary) : '—')}</span>
        {target.frame.length > 0 && <Badge tone="amber">in iframe</Badge>}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOpen(true)}>
          {target.candidates.length} selector{target.candidates.length === 1 ? '' : 's'}
        </Button>
      </div>

      {open && (
        <Modal title="Selectors for this element" onClose={() => setOpen(false)} wide>
          <p className="mb-3 text-xs text-muted">
            The top selector is tried first. If it stops matching, flowcase falls back through the rest and
            checks the element still looks like the one that was recorded before using it.
          </p>

          <div className="flex flex-col gap-1">
            {target.candidates.map((candidate, index) => (
              <label
                key={index}
                className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs ${
                  index === target.primaryIndex ? 'border-brand bg-brand/5' : 'border-line'
                }`}
              >
                <input
                  type="radio"
                  name="primary-selector"
                  checked={index === target.primaryIndex}
                  onChange={() => onChange({ ...target, primaryIndex: index })}
                />
                <Badge>{candidate.engine}</Badge>
                <Input
                  value={candidate.value}
                  onChange={(event) =>
                    onChange({
                      ...target,
                      candidates: target.candidates.map((entry, position) =>
                        position === index ? { ...entry, value: event.target.value, source: 'manual' } : entry,
                      ),
                    })
                  }
                  className="flex-1 font-mono"
                />
                <span className="w-14 text-right text-muted">score {candidate.score}</span>
                {candidate.source === 'healed' && <Badge tone="purple">healed</Badge>}
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    onChange({
                      ...target,
                      candidates: target.candidates.filter((_, position) => position !== index),
                      primaryIndex: 0,
                    })
                  }
                >
                  ✕
                </Button>
              </label>
            ))}
          </div>

          <Button
            size="sm"
            className="mt-3"
            onClick={() =>
              onChange({
                ...target,
                candidates: [...target.candidates, { engine: 'css', value: '', score: 40, source: 'manual' }],
              })
            }
          >
            + Add a selector
          </Button>
        </Modal>
      )}
    </div>
  );
}

function AddStepModal({ onPick, onClose }: { onPick: (kind: StepKind) => void; onClose: () => void }) {
  const [search, setSearch] = useState('');

  const grouped = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return STEP_GROUPS.map((group) => ({
      group,
      items: Object.values(STEP_CATALOG).filter(
        (definition) =>
          definition.group === group &&
          (needle.length === 0 ||
            definition.label.toLowerCase().includes(needle) ||
            definition.description.toLowerCase().includes(needle)),
      ),
    })).filter((entry) => entry.items.length > 0);
  }, [search]);

  return (
    <Modal title="Add a step" onClose={onClose} wide>
      <Input autoFocus placeholder="Search actions…" value={search} onChange={(event) => setSearch(event.target.value)} />

      <div className="mt-3 flex flex-col gap-4">
        {grouped.map(({ group, items }) => (
          <div key={group}>
            <p className="mb-1 text-xs font-medium text-muted">{group}</p>
            <div className="grid gap-1 sm:grid-cols-2">
              {items.map((definition) => (
                <button
                  key={definition.kind}
                  type="button"
                  onClick={() => onPick(definition.kind)}
                  className="rounded-md border border-line px-2.5 py-2 text-left transition hover:border-brand hover:bg-brand/5"
                >
                  <span className="block text-sm font-medium">{definition.label}</span>
                  <span className="block text-[11px] text-muted">{definition.description}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
