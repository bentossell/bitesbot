# Todos

## Role
Personal task management app. Helps track todos with priority levels (high/medium/low) and completion status.

## Data
- data.json is the source of truth for app state
- `todos` array holds all tasks with id, title, completed, priority, createdAt
- `stats` tracks total, completed, and pending counts
- `filter` controls which todos are shown (all/pending/completed)
- Update data.json first, then update ui.json to reflect changes

## UI
- ui.json uses the json-render component catalog
- Only use components from the catalog (see skills/create-app/references/component-catalog.md)
- When updating the UI, read the catalog reference first

## Actions
- Add todo: Add to todos array, update stats
- Complete todo: Set completed=true, update stats
- Delete todo: Remove from array, update stats
- Filter: Change filter value to show subset
