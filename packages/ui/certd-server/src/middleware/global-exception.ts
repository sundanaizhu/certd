import { Provide } from '@midwayjs/core';
import { IMidwayKoaContext, IWebMiddleware, NextFunction } from '@midwayjs/koa';
import { logger } from '@certd/basic';
import { Result } from '@certd/lib-server';

@Provide()
export class GlobalExceptionMiddleware implements IWebMiddleware {
  resolve() {
    return async (ctx: IMidwayKoaContext, next: NextFunction) => {
      const { url } = ctx;
      const startTime = Date.now();
      logger.info('请求开始:', url);
      try {
        await next();
        logger.info('请求完成:', url, Date.now() - startTime + 'ms');
      } catch (err) {
        logger.error('请求异常:', url, Date.now() - startTime + 'ms', err);
        ctx.status = 200;
        if (err.code == null || typeof err.code !== 'number') {
          err.code = 1;
        }
        ctx.body = Result.error(err.code, err.message);
      }
    };
  }
}
