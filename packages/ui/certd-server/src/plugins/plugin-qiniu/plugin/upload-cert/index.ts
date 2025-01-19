import { AbstractTaskPlugin, IsTaskPlugin, pluginGroups, RunStrategy, TaskInput, TaskOutput } from '@certd/pipeline';
import { CertInfo } from '@certd/plugin-cert';
import { QiniuAccess, QiniuClient } from '@certd/plugin-lib';

@IsTaskPlugin({
  name: 'QiniuCertUpload',
  title: '七牛云-上传证书到七牛云',
  icon: 'svg:icon-qiniuyun',
  group: pluginGroups.qiniu.key,
  desc: '上传到七牛云',
  default: {
    strategy: {
      runStrategy: RunStrategy.SkipWhenSucceed,
    },
  },
})
export class QiniuCertUpload extends AbstractTaskPlugin {
  @TaskInput({
    title: '证书名称',
    helper: '上传后将以此名称作为前缀备注',
  })
  certName!: string;

  @TaskInput({
    title: '域名证书',
    helper: '请选择前置任务输出的域名证书',
    component: {
      name: 'output-selector',
      from: ['CertApply', 'CertApplyLego'],
    },
    required: true,
  })
  cert!: CertInfo;

  @TaskInput({
    title: 'Access授权',
    helper: '七牛云授权',
    component: {
      name: 'access-selector',
      type: 'qiniu',
    },
    required: true,
  })
  accessId!: string;

  @TaskOutput({
    title: '上传成功后的七牛云CertId',
  })
  qiniuCertId!: string;

  async onInstance() {}
  async execute(): Promise<void> {
    this.logger.info('开始上传证书到七牛云');
    const access = await this.accessService.getById<QiniuAccess>(this.accessId);
    const qiniuClient = new QiniuClient({
      http: this.ctx.http,
      access,
      logger: this.logger,
    });
    this.qiniuCertId = await qiniuClient.uploadCert(this.cert, this.appendTimeSuffix(this.certName));
    this.logger.info('上传完成,id:', this.qiniuCertId);
  }
}
new QiniuCertUpload();
