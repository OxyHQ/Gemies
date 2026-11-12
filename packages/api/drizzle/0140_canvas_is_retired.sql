-- oxy:deploy-phase=post
--
-- Retires the Canvas workflow editor (its web app and package are deleted). The image this
-- rollout ships has no reader or writer of `workflows` or `workflow_executions`: the `/api/workflows`
-- and `/api/execute` routes and the `subscribe-workflow` socket room are gone with it. Post phase, so
-- they are dropped only after the previous image, which still serves those routes, has drained.
-- Production held 0 workflows and 0 executions when this was written.
DROP TABLE "workflow_executions" CASCADE;--> statement-breakpoint
DROP TABLE "workflows" CASCADE;
