import { ref } from 'vue';
export type TextSize = 'standard' | 'large' | 'extra';
export const textSizes = [
  { value: 'standard' as const, label: '标准', pixels: 18 },
  { value: 'large' as const, label: '大字', pixels: 20 },
  { value: 'extra' as const, label: '特大', pixels: 24 },
];
function initialSize(): TextSize {
  try {
    const value = localStorage.getItem('simcare-text-size');
    return value === 'standard' || value === 'extra' ? value : 'large';
  } catch {
    return 'large';
  }
}
export const textSize = ref<TextSize>(initialSize());
export function setTextSize(value: TextSize) {
  textSize.value = value;
  document.documentElement.style.fontSize = `${(textSizes.find((item) => item.value === value)!.pixels / 16) * 100}%`;
  document.documentElement.dataset.textSize = value;
  try {
    localStorage.setItem('simcare-text-size', value);
  } catch {
    /* A private browser may disable preference storage. */
  }
}
setTextSize(textSize.value);
