# Diffs

## diff

```diff
 viewer/test/render-check.ts
+  a response that is not 200 is an issue
+  no documents matched -> exit 1
-  a 404 page passes
~  findDocs keeps its filters
```

## patch

```patch
@@ -14,7 +14,9 @@ const argv = process.argv.slice(2);
 const config = loadConfig(argv);
-const limit = Number(flag(argv, "limit") ?? Infinity);
+const limit = Number(flag(argv, "limit") ?? Number.POSITIVE_INFINITY);
 const match = flag(argv, "match");
```
