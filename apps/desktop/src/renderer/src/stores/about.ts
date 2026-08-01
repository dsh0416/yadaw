import { acceptHMRUpdate, defineStore } from "pinia"
import { shallowRef } from "vue"

export const useAboutStore = defineStore("about", () => {
  const isOpen = shallowRef(false)

  function open(): void {
    isOpen.value = true
  }

  function close(): void {
    isOpen.value = false
  }

  return { isOpen, open, close }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAboutStore, import.meta.hot))
}
