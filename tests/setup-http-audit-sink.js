import { setDefaultHttpAuditSinkEnabled } from "../src/lib/http-audit.js";

// Production never loads this file. The sink stays enabled in src/.
setDefaultHttpAuditSinkEnabled(false);
