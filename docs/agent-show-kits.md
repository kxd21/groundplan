# Show kits + AI agents

Groundplan uses one **layout recipe** JSON format (`groundplan-layout-recipe` / version `1`) so humans and AI agents build the same whole show — from a ~20-person boardroom to a full concert / arena floor.

## Scale coverage

| Scale | Start here |
|-------|------------|
| ~20 people | New Plan → **Boardroom**, or kit **Boardroom for 20** |
| Meetings / classrooms | Meeting preset; Classroom stamps; seating planner for U / conference / hollow square |
| Banquets | Banquet stamps (rounds); kit **Banquet for 120** |
| Theatre houses | Theatre stamps + bank presets; kit **Card Party South Florida** |
| Concert / arena | New Plan → **Concert floor**; kit **Arena / concert floor sketch** |

Room size presets also include exhibit and arena floors up to 300′ × 200′. Format limit is ~2000′ per side.

## Human flow

1. Open or create a plan with a room.
2. **Create → Show setup → Show kits**.
3. Pick a kit (bundled boardroom / banquet / arena / Card Party, or a user kit) → **Apply kit**.
4. Tweak on the plan with select / stamp / equipment as usual.
5. Under **Add seating**, use scale chips (~20 / Banquet / Theatre / Arena), then save theatre fields as **bank presets** for one-click reload before stamping.

**Import recipe…** / **Export recipe…** round-trip the same JSON ChatGPT / Gemini / Claude can author.

## Recipe shape (summary)

See `src/inventory/layout-recipe.ts` and `tools/fixtures/*-layout-recipe.json`.

- `identity`, `room` (feet)
- `stage[]`, `seating[]` — theatre banks (`rowLengths` / angle), **or** `kind: "round"` / `"schoolroom"` with exact table name
- `gear[]`, `labels[]`, `dimensions[]`
- `expectations.chairs` — apply fails closed if totals disagree

Default seating `kind` is `theatre`. For banquet rounds:

```json
{
  "kind": "round",
  "xFt": 0,
  "yFt": 0,
  "chair": "Chair 20.5W X 23.23D",
  "table": "Round 60\"",
  "seats": 10,
  "expectCount": 10
}
```

U-shape / conference / hollow-square fills are built in the **seating planner** (Room panel), not as recipe stamp kinds yet.

## CLI

```bash
npx tsx tools/apply-layout-recipe.ts tools/fixtures/boardroom-20-layout-recipe.json ~/Downloads/show.rv4
npx tsx tools/apply-layout-recipe.ts tools/fixtures/banquet-120-layout-recipe.json ~/Downloads/banquet.rv4
npx tsx tools/apply-layout-recipe.ts tools/fixtures/arena-floor-layout-recipe.json ~/Downloads/arena.rv4
npx tsx tools/apply-layout-recipe.ts tools/fixtures/card-party-layout-recipe.json ~/Downloads/card-party.rv4
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

1. Ask the model to emit a valid `groundplan-layout-recipe` v1 JSON (use a scale-matched fixture as a template).
2. Save the file.
3. In Groundplan: **Import recipe…** then **Apply kit**, or run the CLI apply tool.

Agents should prefer **exact catalogue names** from inventory — recipes never fuzzy-match gear.
