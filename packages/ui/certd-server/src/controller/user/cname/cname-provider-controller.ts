import { ALL, Body, Controller, Inject, Post, Provide } from '@midwayjs/core';
import { BaseController, Constants } from '@certd/lib-server';
import { CnameRecordService } from '../../../modules/cname/service/cname-record-service.js';
import { CnameProviderService } from '../../../modules/cname/service/cname-provider-service.js';

/**
 * 授权
 */
@Provide()
@Controller('/api/cname/provider')
export class CnameProviderController extends BaseController {
  @Inject()
  service: CnameRecordService;
  @Inject()
  providerService: CnameProviderService;

  getService(): CnameRecordService {
    return this.service;
  }

  @Post('/list', { summary: Constants.per.authOnly })
  async list(@Body(ALL) body: any) {
    body.query = body.query ?? {};
    body.query.userId = this.getUserId();
    const res = await this.providerService.list({});
    return this.ok(res);
  }
}
