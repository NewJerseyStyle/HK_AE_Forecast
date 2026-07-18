import { handle } from "../_shared/core.ts";
Deno.serve((req) => handle(req, "delete"));
