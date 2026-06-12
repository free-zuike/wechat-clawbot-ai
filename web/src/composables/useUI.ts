import { reactive } from 'vue';

interface ToastState {
  visible: boolean;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
  duration: number;
}

interface LoadingState {
  loading: boolean;
  text: string;
}

interface UIState {
  toast: ToastState;
  loading: LoadingState;
}

const state = reactive<UIState>({
  toast: {
    visible: false,
    type: 'info',
    title: '',
    message: '',
    duration: 5000,
  },
  loading: {
    loading: false,
    text: '加载中...',
  },
});

export function useUI() {
  function showToast(options: Partial<ToastState>) {
    state.toast = {
      visible: true,
      type: options.type || 'info',
      title: options.title || '',
      message: options.message || '',
      duration: options.duration ?? 5000,
    };
  }

  function hideToast() {
    state.toast.visible = false;
  }

  function success(message: string, title?: string) {
    showToast({ type: 'success', title: title || '成功', message, duration: 3000 });
  }

  function error(message: string, title?: string) {
    showToast({ type: 'error', title: title || '错误', message, duration: 5000 });
  }

  function warning(message: string, title?: string) {
    showToast({ type: 'warning', title: title || '警告', message, duration: 4000 });
  }

  function info(message: string, title?: string) {
    showToast({ type: 'info', title: title || '提示', message, duration: 4000 });
  }

  function startLoading(text?: string) {
    state.loading = {
      loading: true,
      text: text || '加载中...',
    };
  }

  function stopLoading() {
    state.loading.loading = false;
  }

  return {
    state,
    showToast,
    hideToast,
    success,
    error,
    warning,
    info,
    startLoading,
    stopLoading,
  };
}

export type ToastType = ToastState['type'];