import type { Express } from 'express'
import { z } from 'zod'
import type { Bridge } from './bridge.js'

const threadId = z.string().trim().min(1).max(256)
const readParams = z.object({ threadId }).strict()
const writeParams = z.object({
  threadId,
  objective: z.string().trim().min(1).max(4000).nullish(),
  status: z.enum(['active', 'paused']).optional(),
  tokenBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
}).strict().refine(params => params.objective != null || params.status !== undefined || params.tokenBudget !== undefined, {
  message: 'Specify an objective, status or token budget',
})
const goalRequest = z.discriminatedUnion('method', [
  z.object({ method: z.literal('thread/goal/get'), params: readParams }).strict(),
  z.object({ method: z.literal('thread/goal/set'), params: writeParams }).strict(),
  z.object({ method: z.literal('thread/goal/clear'), params: readParams }).strict(),
])

/** Host-bound goal controls keep an in-flight action on its original workstation. */
export function registerThreadGoals(app: Express, dependencies: { getBridge: (hostId: string) => Promise<Bridge> }) {
  // Registered after authentication, origin and CSRF checks. This deliberately
  // exposes only native user goal controls, rather than a general HTTP RPC proxy.
  app.post('/api/goals/:hostId', (req, res, next) => {
    void (async () => {
      const request = goalRequest.parse(req.body)
      const bridge = await dependencies.getBridge(String(req.params.hostId))
      res.json(await bridge.request(request.method, request.params))
    })().catch(next)
  })
}
