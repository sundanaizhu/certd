import { AbstractTaskPlugin, IsTaskPlugin, pluginGroups, RunStrategy, TaskInput, TaskOutput } from '@certd/pipeline';
import { AliyunAccess } from '@certd/plugin-lib';
import { AliyunSslClient } from '@certd/plugin-lib';

/**
 * 华东1（杭州）	cn-hangzhou	cas.aliyuncs.com	cas-vpc.cn-hangzhou.aliyuncs.com
 * 马来西亚（吉隆坡）	ap-southeast-3	cas.ap-southeast-3.aliyuncs.com	cas-vpc.ap-southeast-3.aliyuncs.com
 * 新加坡	ap-southeast-1	cas.ap-southeast-1.aliyuncs.com	cas-vpc.ap-southeast-1.aliyuncs.com
 * 印度尼西亚（雅加达）	ap-southeast-5	cas.ap-southeast-5.aliyuncs.com	cas-vpc.ap-southeast-5.aliyuncs.com
 * 中国香港	cn-hongkong	cas.cn-hongkong.aliyuncs.com	cas-vpc.cn-hongkong.aliyuncs.com
 *  欧洲与美洲
 * 名称	区域 ID	服务地址	VPC 地址
 * 德国（法兰克福）	eu-central-1	cas.eu-central-1.aliyuncs.com
 */
const regionDict = [
  { value: 'cn-hangzhou', endpoint: 'cas.aliyuncs.com', label: 'cn-hangzhou-中国大陆' },
  { value: 'eu-central-1', endpoint: 'cas.eu-central-1.aliyuncs.com', label: 'eu-central-1-德国（法兰克福）' },
  { value: 'ap-southeast-1', endpoint: 'cas.ap-southeast-1.aliyuncs.com', label: 'ap-southeast-1-新加坡' },
  { value: 'ap-southeast-3', endpoint: 'cas.ap-southeast-3.aliyuncs.com', label: 'ap-southeast-3-马来西亚（吉隆坡）' },
  { value: 'ap-southeast-5', endpoint: 'cas.ap-southeast-5.aliyuncs.com', label: 'ap-southeast-5-印度尼西亚（雅加达）' },
  { value: 'cn-hongkong', endpoint: 'cas.cn-hongkong.aliyuncs.com', label: 'cn-hongkong-中国香港' },
];

@IsTaskPlugin({
  name: 'uploadCertToAliyun',
  title: '阿里云-上传证书到阿里云',
  icon: 'ant-design:aliyun-outlined',
  group: pluginGroups.aliyun.key,
  desc: '如果不想在阿里云上同一份证书上传多次，可以把此任务作为前置任务，其他阿里云任务证书那一项选择此任务的输出',
  default: {
    strategy: {
      runStrategy: RunStrategy.SkipWhenSucceed,
    },
  },
})
export class UploadCertToAliyun extends AbstractTaskPlugin {
  @TaskInput({
    title: '证书名称',
    helper: '证书上传后将以此参数作为名称前缀',
  })
  name!: string;

  @TaskInput({
    title: '大区',
    value: 'cn-hangzhou',
    component: {
      name: 'a-auto-complete',
      vModel: 'value',
      options: regionDict,
    },
    required: true,
  })
  regionId!: string;

  @TaskInput({
    title: '域名证书',
    helper: '请选择前置任务输出的域名证书',
    component: {
      name: 'output-selector',
      from: ['CertApply', 'CertApplyLego'],
    },
    required: true,
  })
  cert!: any;

  @TaskInput({
    title: 'Access授权',
    helper: '阿里云授权AccessKeyId、AccessKeySecret',
    component: {
      name: 'access-selector',
      type: 'aliyun',
    },
    required: true,
  })
  accessId!: string;

  @TaskOutput({
    title: '上传成功后的阿里云CertId',
  })
  aliyunCertId!: string;

  async onInstance() {}

  async execute(): Promise<void> {
    this.logger.info('开始部署证书到阿里云cdn');
    const access: AliyunAccess = await this.accessService.getById(this.accessId);

    let endpoint = '';
    for (const region of regionDict) {
      if (region.value === this.regionId) {
        endpoint = region.endpoint;
        break;
      }
    }
    const client = new AliyunSslClient({
      access,
      logger: this.logger,
      endpoint,
    });
    this.aliyunCertId = await client.uploadCert({
      name: this.appendTimeSuffix('certd'),
      cert: this.cert,
    });
  }
}
//注册插件
new UploadCertToAliyun();
