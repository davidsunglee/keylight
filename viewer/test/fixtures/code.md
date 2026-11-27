# Highlighted code

Fences in the languages the skills and their documents emit.

```ts
export async function runWorkflow(config: Config, workflows: Workflows, options: RunOptions): Promise<number> {
  const steps = workflowNamed(workflows, options.workflow).steps;
  return steps.length;
}
```

```typescript
type Outcome = { kind: "done" } | { kind: "stopped"; reason: string };
```

```tsx
export function Badge({ label }: { label: string }) {
  return <span className="badge">{label}</span>;
}
```

```javascript
const blocks = [...document.querySelectorAll(".mermaid-block")];
blocks.forEach((block) => block.scrollIntoView());
```

```json
{ "name": "keylight", "version": "0.1.0", "private": true }
```

```yaml
task: add-ci-cd-quality-gates
type: structure-outline
```

```sh
bun ci
bun run check
```

```bash
for file in viewer/test/fixtures/*.md; do echo "$file"; done
```

```python
@dataclass
class Document:
    task: str
    number: int

    def link(self) -> str:
        return f"/view/{self.task}/{self.number:02d}"
```

```sql
SELECT name, number FROM documents WHERE task = 'add-ci-cd-quality-gates' ORDER BY number;
```

````markdown
# Heading

- a list item with `code`

```ts
const nested = true;
```
````

```text
plain text keeps its spacing
    and indentation
```
