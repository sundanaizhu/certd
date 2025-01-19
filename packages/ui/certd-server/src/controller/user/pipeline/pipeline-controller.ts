import { ALL, Body, Controller, Inject, Post, Provide, Query } from '@midwayjs/core';
import { Constants, CrudController, SysSettingsService } from '@certd/lib-server';
import { PipelineService } from '../../../modules/pipeline/service/pipeline-service.js';
import { PipelineEntity } from '../../../modules/pipeline/entity/pipeline.js';
import { HistoryService } from '../../../modules/pipeline/service/history-service.js';
import { AuthService } from '../../../modules/sys/authority/service/auth-service.js';

/**
 * 证书
 */
@Provide()
@Controller('/api/pi/pipeline')
export class PipelineController extends CrudController<PipelineService> {
  @Inject()
  service: PipelineService;
  @Inject()
  historyService: HistoryService;
  @Inject()
  authService: AuthService;
  @Inject()
  sysSettingsService: SysSettingsService;

  getService() {
    return this.service;
  }

  @Post('/page', { summary: Constants.per.authOnly })
  async page(@Body(ALL) body) {
    const isAdmin = await this.authService.isAdmin(this.ctx);
    const publicSettings = await this.sysSettingsService.getPublicSettings();
    if (!(publicSettings.managerOtherUserPipeline && isAdmin)) {
      body.query.userId = this.getUserId();
    }

    const title = body.query.title;
    delete body.query.title;

    const buildQuery = qb => {
      if (title) {
        qb.andWhere('(title like :title or content like :content)', { title: `%${title}%`, content: `%${title}%` });
      }
    };
    if (!body.sort || !body.sort?.prop) {
      body.sort = { prop: 'order', asc: false };
    }

    const pageRet = await this.getService().page({
      query: body.query,
      page: body.page,
      sort: body.sort,
      buildQuery,
    });
    return this.ok(pageRet);
  }

  @Post('/add', { summary: Constants.per.authOnly })
  async add(@Body(ALL) bean: PipelineEntity) {
    bean.userId = this.getUserId();
    return super.add(bean);
  }

  @Post('/update', { summary: Constants.per.authOnly })
  async update(@Body(ALL) bean) {
    await this.authService.checkEntityUserId(this.ctx, this.getService(), bean.id);
    delete bean.userId;
    return super.update(bean);
  }

  @Post('/save', { summary: Constants.per.authOnly })
  async save(@Body(ALL) bean: PipelineEntity) {
    if (bean.id > 0) {
      await this.authService.checkEntityUserId(this.ctx, this.getService(), bean.id);
    } else {
      bean.userId = this.getUserId();
    }
    await this.service.save(bean);
    return this.ok(bean.id);
  }

  @Post('/delete', { summary: Constants.per.authOnly })
  async delete(@Query('id') id: number) {
    await this.authService.checkEntityUserId(this.ctx, this.getService(), id);
    await this.service.delete(id);
    return this.ok({});
  }

  @Post('/detail', { summary: Constants.per.authOnly })
  async detail(@Query('id') id: number) {
    await this.authService.checkEntityUserId(this.ctx, this.getService(), id);
    const detail = await this.service.detail(id);
    return this.ok(detail);
  }

  @Post('/trigger', { summary: Constants.per.authOnly })
  async trigger(@Query('id') id: number, @Query('stepId') stepId?: string) {
    await this.authService.checkEntityUserId(this.ctx, this.getService(), id);
    await this.service.trigger(id, stepId);
    return this.ok({});
  }

  @Post('/cancel', { summary: Constants.per.authOnly })
  async cancel(@Query('historyId') historyId: number) {
    await this.authService.checkEntityUserId(this.ctx, this.historyService, historyId);
    await this.service.cancel(historyId);
    return this.ok({});
  }

  @Post('/count', { summary: Constants.per.authOnly })
  async count() {
    const count = await this.service.count({ userId: this.getUserId() });
    return this.ok({ count });
  }

  @Post('/batchDelete', { summary: Constants.per.authOnly })
  async batchDelete(@Body('ids') ids: number[]) {
    await this.service.batchDelete(ids, this.getUserId());
    return this.ok({});
  }

  @Post('/batchUpdateGroup', { summary: Constants.per.authOnly })
  async batchUpdateGroup(@Body('ids') ids: number[], @Body('groupId') groupId: number) {
    await this.service.batchUpdateGroup(ids, groupId, this.getUserId());
    return this.ok({});
  }
}
