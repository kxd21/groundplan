/**
 * Stable command IDs for UI, shortcuts, and agent/automation callers.
 * Keep IDs kebab-stable — never rename without an alias.
 */

import { type CommandId } from '../../shell/command-ids.js';

export type { CommandId } from '../../shell/command-ids.js';
export { COMMAND_IDS, isCommandId, MENU_TO_COMMAND } from '../../shell/command-ids.js';

export type ShellMode = 'browse' | 'place' | 'inspect' | 'setup' | 'draw';

export interface CommandDef {
  id: CommandId;
  title: string;
  subtitle?: string;
  /** Extra search tokens */
  keywords?: string[];
  section: 'Plan' | 'Workspace' | 'Mode' | 'View' | 'Tool' | 'Edit' | 'Show' | 'Help';
  /** Display-only shortcut hint (platform-neutral text OK) */
  shortcut?: string;
  /** Hide from palette when false */
  when?: (ctx: CommandContext) => boolean;
}

export interface CommandContext {
  hasDoc: boolean;
  editable: boolean;
  workspace: 'plan' | 'gear' | 'inventory';
  welcome: boolean;
  shellMode: ShellMode | 'none';
}

export const SHELL_MODES: Array<{
  id: ShellMode;
  label: string;
  hint: string;
  commandId: CommandId;
}> = [
  { id: 'browse', label: 'Browse', hint: 'Recent plans and folders', commandId: 'mode.browse' },
  { id: 'place', label: 'Place', hint: 'Stamp inventory and gear', commandId: 'mode.place' },
  { id: 'inspect', label: 'Inspect', hint: 'Layers and properties', commandId: 'mode.inspect' },
  { id: 'setup', label: 'Setup', hint: 'Show progress: room → kit → stage → seating → print', commandId: 'mode.setup' },
  { id: 'draw', label: 'Draw', hint: 'Drawing tools shelf', commandId: 'mode.draw' },
];

export const COMMAND_CATALOG: CommandDef[] = [
  {
    id: 'palette.open',
    title: 'Command palette',
    subtitle: 'Search every action',
    section: 'Help',
    shortcut: '⌘K',
    keywords: ['search', 'ai', 'actions'],
  },
  {
    id: 'plan.new',
    title: 'New plan',
    subtitle: 'Room-first show setup',
    section: 'Plan',
    shortcut: '⌘N',
    keywords: ['create', 'show'],
  },
  {
    id: 'plan.open',
    title: 'Open plan',
    section: 'Plan',
    shortcut: '⌘O',
    keywords: ['file'],
  },
  {
    id: 'plan.open-folder',
    title: 'Open folder',
    section: 'Plan',
    shortcut: '⇧⌘O',
    keywords: ['browse', 'directory'],
  },
  {
    id: 'plan.save',
    title: 'Save',
    section: 'Plan',
    shortcut: '⌘S',
    when: (c) => c.hasDoc || c.workspace === 'gear',
  },
  {
    id: 'plan.save-as',
    title: 'Save as…',
    section: 'Plan',
    shortcut: '⇧⌘S',
    when: (c) => c.hasDoc || c.workspace === 'gear',
  },
  {
    id: 'plan.print',
    title: 'Print / PDF',
    section: 'Plan',
    shortcut: '⌘P',
    when: (c) => c.hasDoc,
  },
  {
    id: 'plan.export-dxf',
    title: 'Export DXF',
    section: 'Plan',
    shortcut: '⇧⌘D',
    keywords: ['cad'],
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'plan.export-svg',
    title: 'Export SVG',
    section: 'Plan',
    shortcut: '⌘E',
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'workspace.plan',
    title: 'Workspace: Plan',
    section: 'Workspace',
    keywords: ['floor', 'canvas'],
  },
  {
    id: 'workspace.gear',
    title: 'Workspace: Gear',
    section: 'Workspace',
    keywords: ['packing', 'list'],
  },
  {
    id: 'workspace.inventory',
    title: 'Workspace: Inventory',
    section: 'Workspace',
    keywords: ['catalog', 'shapes'],
  },
  {
    id: 'mode.browse',
    title: 'Mode: Browse',
    subtitle: 'Recent plans and folders',
    section: 'Mode',
    shortcut: '⌘B',
    keywords: ['browser', 'files', 'rail'],
    when: (c) => c.workspace === 'plan' && c.hasDoc,
  },
  {
    id: 'mode.place',
    title: 'Mode: Place',
    subtitle: 'Stamp inventory and gear',
    section: 'Mode',
    keywords: ['equipment', 'insert', 'stamp'],
    when: (c) => c.workspace === 'plan' && c.hasDoc,
  },
  {
    id: 'mode.inspect',
    title: 'Mode: Inspect',
    subtitle: 'Layers and properties',
    section: 'Mode',
    shortcut: '⌘⇧B',
    keywords: ['inspector', 'properties', 'layers'],
    when: (c) => c.workspace === 'plan' && c.hasDoc,
  },
  {
    id: 'mode.setup',
    title: 'Mode: Setup',
    subtitle: 'Show progress: room, kit, stage, seating, print',
    section: 'Mode',
    keywords: ['create', 'show setup', 'kit'],
    when: (c) => c.workspace === 'plan' && c.hasDoc,
  },
  {
    id: 'mode.draw',
    title: 'Mode: Draw',
    subtitle: 'Drawing tools shelf',
    section: 'Mode',
    keywords: ['tools', 'dock', 'line', 'rect'],
    when: (c) => c.workspace === 'plan' && c.hasDoc,
  },
  {
    id: 'mode.none',
    title: 'Hide side panels',
    subtitle: 'Full canvas',
    section: 'Mode',
    when: (c) => c.workspace === 'plan' && c.hasDoc,
  },
  {
    id: 'view.fit',
    title: 'Zoom to fit',
    section: 'View',
    shortcut: '0',
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'view.grid',
    title: 'Toggle grid',
    section: 'View',
    shortcut: 'G',
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'view.stack',
    title: 'Toggle stack markers',
    section: 'View',
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'view.sight',
    title: 'Toggle sightline markers',
    section: 'View',
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'tool.select',
    title: 'Select tool',
    section: 'Tool',
    shortcut: 'V',
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'tool.hand',
    title: 'Hand tool',
    section: 'Tool',
    shortcut: 'H',
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'tool.text',
    title: 'Text tool',
    section: 'Tool',
    shortcut: 'T',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'tool.measure',
    title: 'Measure tool',
    section: 'Tool',
    shortcut: 'M',
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'tool.dimension',
    title: 'Dimension tool',
    section: 'Tool',
    shortcut: 'D',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'room.edit',
    title: 'Edit room',
    subtitle: 'Focused room layout workspace',
    section: 'Show',
    shortcut: 'W',
    keywords: ['walls', 'outline'],
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'room.walls',
    title: 'Edit walls',
    subtitle: 'Push, curve, or stretch walls on the plan',
    section: 'Show',
    keywords: ['push', 'curve'],
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'room.outline',
    title: 'Draw room outline',
    section: 'Show',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'seating.planner',
    title: 'Seating planner',
    section: 'Show',
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'stage.build',
    title: 'Build stage',
    section: 'Show',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'insert.open',
    title: 'Insert / Place',
    section: 'Show',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'shape.wizard',
    title: 'Shape wizard',
    section: 'Show',
    keywords: ['trace', 'custom'],
    when: (c) => c.workspace === 'plan',
  },
  {
    id: 'calc.open',
    title: 'Space calculator',
    section: 'Show',
    when: (c) => c.workspace === 'plan',
  },
  {
    id: 'edit.undo',
    title: 'Undo',
    section: 'Edit',
    shortcut: '⌘Z',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.redo',
    title: 'Redo',
    section: 'Edit',
    shortcut: '⌘⇧Z',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.select-all',
    title: 'Select all',
    section: 'Edit',
    shortcut: '⌘A',
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'edit.duplicate',
    title: 'Duplicate selection',
    section: 'Edit',
    shortcut: '⌘D',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.delete',
    title: 'Delete selection',
    section: 'Edit',
    shortcut: '⌫',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.group',
    title: 'Group selection',
    section: 'Edit',
    shortcut: '⌘G',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.ungroup',
    title: 'Ungroup selection',
    section: 'Edit',
    shortcut: '⌘⇧G',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'settings.open',
    title: 'Settings',
    section: 'Help',
    keywords: ['preferences'],
  },
  {
    id: 'help.shortcuts',
    title: 'Keyboard shortcuts',
    section: 'Help',
    shortcut: '?',
  },
];

/** Section order for the Help → Keyboard shortcuts sheet. */
export const SHORTCUT_SECTION_ORDER: CommandDef['section'][] = [
  'Plan',
  'Edit',
  'Mode',
  'View',
  'Tool',
  'Show',
  'Workspace',
  'Help',
];

/** Canvas gestures that are not (yet) first-class command IDs. */
export const EXTRA_SHORTCUTS: Array<{
  keys: string[];
  title: string;
  section: CommandDef['section'];
}> = [
  { keys: ['S'], title: 'Toggle snap', section: 'Tool' },
  { keys: ['['], title: 'Rotate 90° left', section: 'Edit' },
  { keys: [']'], title: 'Rotate 90° right', section: 'Edit' },
  { keys: ['Arrow keys'], title: 'Nudge selection', section: 'Edit' },
  { keys: ['⌘C'], title: 'Copy items between plan tabs', section: 'Edit' },
  { keys: ['⌘V'], title: 'Paste copied plan items', section: 'Edit' },
];

export function localizeShortcutHint(hint: string, platform: string): string {
  if (platform === 'darwin') return hint;
  return hint
    .replaceAll('⌘⇧', 'Ctrl+Shift+')
    .replaceAll('⇧⌘', 'Ctrl+Shift+')
    .replaceAll('⌘', 'Ctrl+')
    .replaceAll('⇧', 'Shift+')
    .replaceAll('⌥', 'Alt+')
    .replaceAll('⌫', 'Backspace');
}

/** Build the Help shortcuts sheet from the command catalog (+ a few canvas extras). */
export function shortcutCheatSheet(platform: string): Array<{
  section: string;
  rows: Array<{ keys: string[]; title: string }>;
}> {
  const buckets = new Map<string, Array<{ keys: string[]; title: string }>>();
  const push = (section: string, keys: string[], title: string) => {
    const list = buckets.get(section) ?? [];
    list.push({
      keys: keys.map((key) => localizeShortcutHint(key, platform)),
      title,
    });
    buckets.set(section, list);
  };

  for (const cmd of COMMAND_CATALOG) {
    if (!cmd.shortcut) continue;
    push(cmd.section, [cmd.shortcut], cmd.title);
  }
  for (const extra of EXTRA_SHORTCUTS) {
    push(extra.section, extra.keys, extra.title);
  }

  const ordered: Array<{ section: string; rows: Array<{ keys: string[]; title: string }> }> =
    SHORTCUT_SECTION_ORDER.filter((section) => buckets.has(section)).map((section) => ({
      section,
      rows: buckets.get(section)!,
    }));
  for (const [section, rows] of buckets) {
    if (!SHORTCUT_SECTION_ORDER.includes(section as CommandDef['section'])) {
      ordered.push({ section, rows });
    }
  }
  return ordered;
}

export function deriveShellMode(flags: {
  createDialogOpen: boolean;
  toolDockOpen: boolean;
  inspectorOpen: boolean;
  railOpen: boolean;
  planRailSource: string;
}): ShellMode | 'none' {
  if (flags.createDialogOpen) return 'setup';
  if (flags.toolDockOpen) return 'draw';
  if (flags.inspectorOpen) return 'inspect';
  if (flags.railOpen && flags.planRailSource === 'equipment') return 'place';
  if (flags.railOpen) return 'browse';
  return 'none';
}

export function filterCommands(
  catalog: CommandDef[],
  ctx: CommandContext,
  query: string,
): CommandDef[] {
  const q = query.trim().toLowerCase();
  return catalog.filter((cmd) => {
    if (cmd.when && !cmd.when(ctx)) return false;
    if (cmd.id === 'palette.open') return false;
    if (!q) return true;
    const hay = [cmd.title, cmd.subtitle, cmd.section, ...(cmd.keywords ?? []), cmd.id]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q) || q.split(/\s+/).every((part) => hay.includes(part));
  });
}
