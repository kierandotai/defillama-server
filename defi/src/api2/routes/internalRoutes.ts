
import { deleteFromPGCache, } from "../cache/file-cache";
import * as HyperExpress from "hyper-express";
import { errorResponse } from "./utils";
import { clearDimensionsCacheV2 } from "../utils/dimensionsUtils";


const INTERNAL_SECRET_KEY = process.env.LLAMA_INTERNAL_ROUTE_KEY ?? process.env.LLAMA_PRO_API2_SECRET_KEY ?? process.env.API2_SUBPATH

export function setInternalRoutes(router: HyperExpress.Router, _routerBasePath: string) {

  router.get('/debug-pg/*', debugHandler)
  router.delete('/debug-pg/*', debugHandler)

  async function debugHandler(req: any, res: any) {
    const fullPath = req.path;
    const routerPath = fullPath.split('debug-pg')[1];
    const secretKey = req.headers['x-internal-secret'] ?? req.query['x-internal-secret']
    try {
      if (!INTERNAL_SECRET_KEY)
        throw new Error('Internal secret key not defined')

      if (process.env.API2_SKIP_SUBPATH === 'true')
        if (!secretKey || secretKey !== INTERNAL_SECRET_KEY)
          throw new Error('Unauthorized')

      // there is no need for else, as API2_SUBPATH would act as the temp secret key in this case

      switch (req.method) {
        case 'DELETE':
          if (routerPath === '/clear-dimensions-cache') {
            await clearDimensionsCacheV2()
          } else
            await deleteFromPGCache(routerPath)
          return res.json({ success: true })
        default:
          throw new Error('Unsupported method')
      }
    } catch (e) {
      console.error(e);
      return errorResponse(res, 'Internal server error', { statusCode: 500 })
    }
  }
}
