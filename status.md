# status — MCP tool annotations

```
ROADMAP  ████████████████████  8/8 done
 [x] 1. Read #124 assessment; confirm annotations are blocker #1
 [x] 2. Fetch CURRENT spec field names (SDK ToolAnnotationsSchema, not memory)
 [x] 3. Classify 41 tool names by reading each implementation
 [x] 4. Attach annotations at the tools/list choke point
 [x] 5. Add e2e test: contract + self-check + real-wire
 [x] 6. Prove fail-then-pass (missing AND misclassified) -> exit 1, then 0
 [x] 7. Build + full test:ci green (11/11), PR #125, CI pass
 [x] 8. Merge 18bb9de, delete branch + worktree
```

WHY SLOW
 - Nothing blocking. One real bug found en route: `click` was classified
   readOnlyHint:true, contradicting its own consistency list. Fixed.

NEXT
 - Blocker #2 from #124 remains open and is NOT addressed here: a directory
   reviewer still has no browser for us to drive. That gates the Anthropic
   Connectors and OpenAI Plugins submissions regardless of annotations.
 - No registry republish needed: the registry manifest carries no tool
   annotations (verified against the live API), so 0.3.3 stays isLatest.
