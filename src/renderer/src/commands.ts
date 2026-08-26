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
    title: 'Files',
    subtitle: 'Recent plans and folders',
    section: 'Workspace',
    shortcut: '⌘B',
    keywords: ['browser', 'files', 'rail'],
    when: (c) => c.workspace === 'plan' && c.hasDoc,
  },
  {
    id: 'mode.place',
    title: 'Assets',
    subtitle: 'Stamp inventory and gear',
    section: 'Workspace',
    keywords: ['equipment', 'insert', 'stamp'],
    when: (c) => c.workspace === 'plan' && c.hasDoc,
  },
  {
    id: 'mode.inspect',
    title: 'Properties',
    subtitle: 'Layers and properties',
    section: 'Workspace',
    shortcut: '⌘⇧B',
    keywords: ['inspector', 'properties', 'layers'],
    when: (c) => c.workspace === 'plan' && c.hasDoc,
  },
  {
    id: 'mode.setup',
    title: 'Show Setup',
    subtitle: 'The brief, the room, the layout, and what the plan still needs',
    section: 'Workspace',
    // "layout" and "kit" stay searchable: the panel still does both, and
    // somebody who learned the old name should still find it.
    keywords: ['create', 'layout', 'kit', 'brief', 'show', 'readiness'],
    when: (c) => c.workspace === 'plan' && c.hasDoc,
  },
  {
    id: 'mode.draw',
    title: 'All canvas tools',
    subtitle: 'Expanded drawing and measurement list',
    section: 'Workspace',
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
  /*
   * Everything below was reachable only by finding the right panel. The palette
   * covered 44 actions against roughly 180 the app can actually do, which meant
   * a user who could not find a panel did not have the feature — align,
   * distribute, flip, reorder and auto-dimension were all in that gap.
   */
  {
    id: 'edit.copy',
    title: 'Copy selection',
    section: 'Edit',
    shortcut: '⌘C',
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'edit.paste',
    title: 'Paste',
    section: 'Edit',
    shortcut: '⌘V',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.rotate-cw',
    title: 'Rotate right 90°',
    keywords: ['turn', 'clockwise'],
    section: 'Edit',
    shortcut: ']',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.rotate-ccw',
    title: 'Rotate left 90°',
    keywords: ['turn', 'anticlockwise', 'counterclockwise'],
    section: 'Edit',
    shortcut: '[',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.flip-horizontal',
    title: 'Flip horizontally',
    keywords: ['mirror'],
    section: 'Edit',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.flip-vertical',
    title: 'Flip vertically',
    keywords: ['mirror'],
    section: 'Edit',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.align-left',
    title: 'Align left',
    section: 'Edit',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.align-center',
    title: 'Align centres horizontally',
    section: 'Edit',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.align-right',
    title: 'Align right',
    section: 'Edit',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.align-top',
    title: 'Align top',
    section: 'Edit',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.align-middle',
    title: 'Align middles vertically',
    section: 'Edit',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.align-bottom',
    title: 'Align bottom',
    section: 'Edit',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.distribute-horizontal',
    title: 'Distribute evenly across',
    keywords: ['space', 'spread'],
    section: 'Edit',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.distribute-vertical',
    title: 'Distribute evenly down',
    keywords: ['space', 'spread'],
    section: 'Edit',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.bring-to-front',
    title: 'Bring to front',
    keywords: ['order', 'raise'],
    section: 'Edit',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'edit.send-to-back',
    title: 'Send to back',
    keywords: ['order', 'lower'],
    section: 'Edit',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'plan.dimension-room',
    title: 'Dimension the room',
    subtitle: 'A dimension on every wall',
    keywords: ['measure', 'auto'],
    section: 'Plan',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'plan.dimension-room-corners',
    title: 'Dimension the room and its corner angles',
    subtitle: 'Adds the angle at every corner that is not square',
    keywords: ['measure', 'auto', 'angle'],
    section: 'Plan',
    when: (c) => c.hasDoc && c.editable && c.workspace === 'plan',
  },
  {
    id: 'view.layers-show-all',
    title: 'Show all layers',
    section: 'View',
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'view.layers-hide-all',
    title: 'Hide all layers',
    section: 'View',
    when: (c) => c.hasDoc && c.workspace === 'plan',
  },
  {
    id: 'view.snap',
    title: 'Toggle snapping',
    keywords: ['grid', 'snap'],
    section: 'View',
    shortcut: 'S',
    when: (c) => c.hasDoc && c.workspace === 'plan',
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
