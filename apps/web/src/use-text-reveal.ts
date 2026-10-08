import { computed, onUnmounted, ref, watch } from 'vue';

// Present an already validated answer. This does not consume provider tokens.
// Keep the same timing/accessibility policy as the existing DiagnosisAnswer.
export function useTextReveal(
  text: () => string | null,
  key: () => string,
  animate: () => boolean,
  complete: () => void,
) {
  const characters = computed(() => Array.from(text() ?? '')),
    visible = ref(0);
  let timer: ReturnType<typeof setInterval> | undefined,
    currentKey = '',
    currentText = '';
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  watch(
    () => [key(), text() ?? '', animate()] as const,
    ([id, value, play]) => {
      if (id === currentKey && value === currentText) {
        if (!play) {
          stop();
          visible.value = characters.value.length;
        }
        return;
      }
      stop();
      currentKey = id;
      currentText = value;
      visible.value = 0;
      if (!value) return;
      const reduced =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!play || reduced) {
        visible.value = characters.value.length;
        complete();
        return;
      }
      const duration = Math.min(4000, Math.max(600, characters.value.length * 12));
      const step = Math.max(1, Math.ceil(characters.value.length / (duration / 40)));
      timer = setInterval(() => {
        visible.value = Math.min(characters.value.length, visible.value + step);
        if (visible.value === characters.value.length) {
          stop();
          complete();
        }
      }, 40);
    },
    { immediate: true },
  );
  onUnmounted(stop);
  return {
    shown: computed(() => characters.value.slice(0, visible.value).join('')),
    revealing: computed(() => visible.value < characters.value.length),
  };
}
