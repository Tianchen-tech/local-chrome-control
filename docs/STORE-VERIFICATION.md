# Store candidate verification

Identity: `mppejcndepnklbbjjjdgbobmjfhhddfe`. Source baseline: `69965e6` (0.3.1). Browser upload ZIP SHA-256: `f10f33cfec8c7b2454c67b84680b81c045173a32008d5acc29c2c4ab940a216b`.

The public key supplied by the publisher derives exactly this item ID. The separate store companion keeps it; the browser ZIP strips it. No installed developer extension or native registration was changed on the publisher's Mac.

Local Mac checks: 132 tests passed, 6 Windows-only tests skipped; manifest/syntax/15-tool checks and a real CDP browser regression passed. A newly extracted companion regenerated its own MCP paths and previewed the correct store origin. Runtime has no npm production dependencies; test-only dependencies are excluded from the browser ZIP and no node_modules is distributed.

[First store CI run](https://github.com/Tianchen-tech/local-chrome-control/actions/runs/37727487552) preserved two failures. All four Mac/Windows × Node 22/24 jobs passed their unit tests and new clean store-identity registration/native-transport check. Mac Node 22 failed before page input: a cold `Target.setAutoAttach` reply took 3158 ms and exceeded the product's 3000 ms initialization bound. Windows Node 22 did not produce DevToolsActivePort within the probe's ten-second startup budget. The two Node 24 jobs passed their browser probes.

The development-only probe now allows 30 seconds for its fresh profile to start and explicitly records bounded retries of its own idempotent debugger initialization before any page action. Production extension deadlines and browser code are unchanged. Inputs are never retried. These probe adjustments do not fix or prove real extension cold-start behavior: under slow Chrome initialization, a user grant can still fail and require a new manual authorization after Chrome is ready.

The native registration test uses the actual registered shell/executable launcher, real Unix socket/Windows named pipe and a real MCP process, but simulates the Chrome message endpoint. The separate real-browser probe uses CDP through a test adapter. Neither is a Chrome Store installation or personal-profile consent test. Store download installation and personal Mac/Windows Chrome profiles still require the manual reviewer flow.
