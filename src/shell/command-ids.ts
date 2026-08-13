/**
 * Stable command IDs shared by renderer UI, ⌘K palette, and agent IPC.
 * Keep IDs kebab-stable — never rename without an alias.
 */

export const COMMAND_IDS = [
  'palette.open',
  'plan.new',
  'plan.open',
  'plan.open-folder',
  'plan.save',
  'plan.save-as',
  'plan.print',
  'plan.export-dxf',
  'plan.export-svg',
  'workspace.plan',
  'workspace.gear',
  'workspace.inventory',
  'mode.browse',
  'mode.place',
  'mode.inspect',
  'mode.setup',
  'mode.draw',
  'mode.none',
  'view.fit',
  'view.grid',
  'view.stack',
  'view.sight',
  'tool.select',
  'tool.hand',
  'tool.text',
  'tool.measure',
  'tool.dimension',
  'room.edit',
  'room.walls',
  'room.outline',
  'seating.planner',
  'stage.build',
  'insert.open',
  'shape.wizard',
  'calc.open',
  'settings.open',
  'help.shortcuts',
  'edit.undo',
  'edit.redo',
  'edit.delete',
  'edit.duplicate',
  'edit.group',
  'edit.ungroup',
  'edit.select-all',
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && (COMMAND_IDS as readonly string[]).includes(value);
}

export interface CommandListEntry {
  id: CommandId;
  title: string;
  section: string;
  shortcut?: string;
}

/** Titles for IPC `command:list` — keep in sync with renderer COMMAND_CATALOG. */
export const COMMAND_LIST: CommandListEntry[] = [
  { id: 'palette.open', title: 'Command palette', section: 'Help', shortcut: '⌘K' },
  { id: 'plan.new', title: 'New plan', section: 'Plan', shortcut: '⌘N' },
  { id: 'plan.open', title: 'Open plan', section: 'Plan', shortcut: '⌘O' },
  { id: 'plan.open-folder', title: 'Open folder', section: 'Plan', shortcut: '⇧⌘O' },
  { id: 'plan.save', title: 'Save', section: 'Plan', shortcut: '⌘S' },
  { id: 'plan.save-as', title: 'Save as…', section: 'Plan', shortcut: '⇧⌘S' },
  { id: 'plan.print', title: 'Print / PDF', section: 'Plan', shortcut: '⌘P' },
  { id: 'plan.export-dxf', title: 'Export DXF', section: 'Plan', shortcut: '⇧⌘D' },
  { id: 'plan.export-svg', title: 'Export SVG', section: 'Plan', shortcut: '⌘E' },
  { id: 'workspace.plan', title: 'Workspace: Plan', section: 'Workspace' },
  { id: 'workspace.gear', title: 'Workspace: Gear', section: 'Workspace' },
  { id: 'workspace.inventory', title: 'Workspace: Inventory', section: 'Workspace' },
  { id: 'mode.browse', title: 'Mode: Browse', section: 'Mode', shortcut: '⌘B' },
  { id: 'mode.place', title: 'Mode: Place', section: 'Mode' },
  { id: 'mode.inspect', title: 'Mode: Inspect', section: 'Mode', shortcut: '⌘⇧B' },
  { id: 'mode.setup', title: 'Mode: Setup', section: 'Mode' },
  { id: 'mode.draw', title: 'Mode: Draw', section: 'Mode' },
  { id: 'mode.none', title: 'Hide side panels', section: 'Mode' },
  { id: 'view.fit', title: 'Zoom to fit', section: 'View', shortcut: '0' },
  { id: 'view.grid', title: 'Toggle grid', section: 'View', shortcut: 'G' },
  { id: 'view.stack', title: 'Toggle stack markers', section: 'View' },
  { id: 'view.sight', title: 'Toggle sightline grades', section: 'View' },
  { id: 'tool.select', title: 'Select tool', section: 'Tool', shortcut: 'Esc' },
  { id: 'tool.hand', title: 'Hand tool', section: 'Tool', shortcut: 'H' },
  { id: 'tool.text', title: 'Text tool', section: 'Tool', shortcut: 'T' },
  { id: 'tool.measure', title: 'Measure tool', section: 'Tool', shortcut: 'M' },
  { id: 'tool.dimension', title: 'Dimension tool', section: 'Tool', shortcut: 'D' },
  { id: 'room.edit', title: 'Edit room', section: 'Show', shortcut: 'W' },
  { id: 'room.walls', title: 'Edit walls', section: 'Show' },
  { id: 'room.outline', title: 'Draw room outline', section: 'Show' },
  { id: 'seating.planner', title: 'Seating planner', section: 'Show' },
  { id: 'stage.build', title: 'Build stage', section: 'Show' },
  { id: 'insert.open', title: 'Insert / Place', section: 'Show' },
  { id: 'shape.wizard', title: 'Shape wizard', section: 'Show' },
  { id: 'calc.open', title: 'Space calculator', section: 'Show' },
  { id: 'settings.open', title: 'Settings', section: 'Help' },
  { id: 'help.shortcuts', title: 'Keyboard shortcuts', section: 'Help', shortcut: '?' },
  { id: 'edit.undo', title: 'Undo', section: 'Edit', shortcut: '⌘Z' },
  { id: 'edit.redo', title: 'Redo', section: 'Edit', shortcut: '⇧⌘Z' },
  { id: 'edit.delete', title: 'Delete selection', section: 'Edit', shortcut: '⌫' },
  { id: 'edit.duplicate', title: 'Duplicate selection', section: 'Edit', shortcut: '⌘D' },
  { id: 'edit.group', title: 'Group selection', section: 'Edit', shortcut: '⌘G' },
  { id: 'edit.ungroup', title: 'Ungroup selection', section: 'Edit', shortcut: '⌘⇧G' },
  { id: 'edit.select-all', title: 'Select all', section: 'Edit', shortcut: '⌘A' },
];

/** Map legacy menu IPC channels onto structured command IDs. */
export const MENU_TO_COMMAND: Record<string, CommandId> = {
  'menu:settings': 'settings.open',
  'menu:new': 'plan.new',
  'menu:open': 'plan.open',
  'menu:open-folder': 'plan.open-folder',
  'menu:save': 'plan.save',
  'menu:save-as': 'plan.save-as',
  'menu:print': 'plan.print',
  'menu:export-dxf': 'plan.export-dxf',
  'menu:export-svg': 'plan.export-svg',
  'menu:undo': 'edit.undo',
  'menu:redo': 'edit.redo',
  'menu:fit': 'view.fit',
  'menu:insert': 'insert.open',
  'menu:build-stage': 'stage.build',
  'menu:edit-walls': 'room.walls',
  'menu:group': 'edit.group',
  'menu:ungroup': 'edit.ungroup',
  'menu:select-all': 'edit.select-all',
  'menu:shape-wizard': 'shape.wizard',
  'menu:palette': 'palette.open',
  'menu:shortcuts': 'help.shortcuts',
  'menu:mode-browse': 'mode.browse',
  'menu:mode-place': 'mode.place',
  'menu:mode-inspect': 'mode.inspect',
  'menu:mode-setup': 'mode.setup',
  'menu:mode-draw': 'mode.draw',
};