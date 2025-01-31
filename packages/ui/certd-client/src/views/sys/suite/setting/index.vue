<template>
  <fs-page class="page-sys-settings page-sys-settings-suite">
    <template #header>
      <div class="title">
        套餐设置
        <span class="sub"> 需要<router-link :to="{ path: '/sys/settings', query: { tab: 'payment' } }">开启至少一种支付方式</router-link></span>
      </div>
    </template>

    <div class="form-content">
      <a-form ref="formRef" :model="formState" :label-col="{ style: { width: '150px' } }" :wrapper-col="{ span: 20 }" autocomplete="off">
        <a-form-item label="开启套餐功能" name="enabled" required>
          <a-switch v-model:checked="formState.enabled" />
        </a-form-item>
        <template v-if="formState.enabled">
          <a-form-item label="套餐列表" name="enabled">
            <div style="height: 400px">
              <ProductManager @refreshed="onTableRefresh"></ProductManager>
            </div>
          </a-form-item>

          <a-form-item label="注册赠送套餐" name="registerGift">
            <suite-duration-selector ref="suiteDurationSelectedRef" v-model="formState.registerGift"></suite-duration-selector>
            <div class="helper">添加套餐后再选择</div>
          </a-form-item>
          <a-form-item label="套餐说明" name="intro">
            <a-textarea v-model:value="formState.intro" :rows="3"></a-textarea>
            <div class="helper">将显示在套餐购买页面</div>
          </a-form-item>
        </template>

        <a-form-item label=" " :colon="false">
          <loading-button type="primary" html-type="button" :click="onClick">保存</loading-button>
          <div class="helper">需要 <router-link :to="{ path: '/sys/settings', query: { tab: 'payment' } }">开启至少一种支付方式</router-link></div>
        </a-form-item>
      </a-form>
    </div>
  </fs-page>
</template>

<script lang="ts" setup>
import { reactive, ref } from "vue";
import { merge } from "lodash-es";
import { notification } from "ant-design-vue";
import { request } from "/@/api/service";
import SuiteDurationSelector from "/@/views/sys/suite/setting/suite-duration-selector.vue";
import ProductManager from "/@/views/sys/suite/product/index.vue";
import { useSettingStore } from "/@/store/modules/settings";

defineOptions({
  name: "SettingsSuite"
});

const api = {
  async SuiteSettingGet() {
    return await request({
      url: "/sys/settings/suite/get",
      method: "post"
    });
  },
  async SuiteSettingSave(data: any) {
    return await request({
      url: "/sys/settings/suite/save",
      method: "post",
      data
    });
  }
};

const formRef = ref<any>(null);
const formState = reactive<
  Partial<{
    enabled: boolean;
    registerGift?: {
      productId?: number;
      duration?: number;
    };
    intro?: string;
  }>
>({ enabled: false });

async function loadSettings() {
  const data: any = await api.SuiteSettingGet();
  merge(formState, data);
}

const settingsStore = useSettingStore();
loadSettings();
const onClick = async () => {
  const form = await formRef.value.validateFields();
  await api.SuiteSettingSave(form);
  await loadSettings();
  await settingsStore.loadSysSettings();
  notification.success({
    message: "保存成功"
  });
};

const suiteDurationSelectedRef = ref();
function onTableRefresh() {
  suiteDurationSelectedRef.value?.refresh();
}
</script>

<style lang="less">
.page-sys-settings-suite {
  .form-content {
    padding: 20px;
    .ant-table-body {
      height: 400px !important;
    }
  }
}
</style>
