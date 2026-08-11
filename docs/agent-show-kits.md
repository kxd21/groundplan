# Show kits + AI agents

Groundplan uses one **layout recipe** JSON format (`groundplan-layout-recipe` / version `1`) so humans and AI agents build the same whole show.

## Human flow

1. Open or create a plan with a room.
2. **Create → Show setup → Show kits**.
3. Pick a kit (bundled Card Party South Florida, or a user kit) → **Apply kit**.
4. Tweak on the plan with select / stamp / equipment as usual.
5. Under **Add seating**, save theatre fields as **bank presets** for one-click reload before stamping.

**Import recipe…** / **Export recipe…** round-trip the same JSON ChatGPT / Gemini / Claude can author.

## Recipe shape (summary)

See `src/inventory/layout-recipe.ts` and `tools/fixtures/card-party-layout-recipe.json`.

- `identity`, `room` (feet)
- `stage[]`, `seating[]` (theatre banks with `rowLengths` / angle / exact chair name)
- `gear[]`, `labels[]`, `dimensions[]`
- `expectations.chairs` — apply fails closed if totals disagree

## CLI

```bash
npx tsx tools/apply-layout-recipe.ts tools/fixtures/card-party-layout-recipe.json ~/Downloads/show.rv4
```

## MCP (Cursor / Claude Desktop)

Run the stdio MCP server:

```bash
npx tsx tools/groundplan-mcp.ts
```

Example Cursor MCP config entry:

```json
{
  "mcpServers": {
    "groundplan": {
      "command": "npx",
      "args": ["tsx", "tools/groundplan-mcp.ts"],
      "cwd": "/absolute/path/to/Groundplan"
    }
  }
}
```

Tools:

| Tool | Purpose |
|------|---------|
| `validate_layout_recipe` | Check seat maths / structure |
| `list_layout_kits` | Bundled + user kits |
| `apply_layout_recipe` | Write a complete `.rv4` from recipe / kit / path |
| `open_plan_summary` | Chair & gear counts on an existing plan |

Optional: set `GROUNDPLAN_USER_DATA` to the same kits folder the app uses if you want shared user kits outside Electron’s userData.

## ChatGPT / Gemini without MCP

1. Ask the model to emit a valid `groundplan-layout-recipe` v1 JSON (use the Card Party fixture as a template).
2. Save the file.
3. In Groundplan: **Import recipe…** then **Apply kit**, or run the CLI apply tool.

Agents should prefer **exact catalogue names** from inventory — recipes never fuzzy-match gear.
