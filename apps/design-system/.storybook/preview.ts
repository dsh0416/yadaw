import type { Decorator, Preview } from "@storybook/vue3-vite"
import { setup } from "@storybook/vue3"
import { createHead } from "@unhead/vue/client"
import { createPinia, setActivePinia } from "pinia"
import { withThemeByDataAttribute } from "@storybook/addon-themes"

import { UiProvider, useLocaleFonts } from "@yadaw/ui"
import "unfonts.css"
import "@yadaw/ui/styles.css"
import "./preview.css"

setup((app) => {
  app.use(createHead())
})

const withIsolatedUiContext: Decorator = (story, context) => ({
  components: { story, UiProvider },
  setup() {
    setActivePinia(createPinia())
    useLocaleFonts("en-US")
    return {
      motion: context.globals.motion as string
    }
  },
  template: `
    <div class="storybook-stage" :data-ui-motion="motion === 'enabled' ? undefined : 'disabled'">
      <UiProvider>
        <story />
      </UiProvider>
    </div>
  `
})

const preview: Preview = {
  decorators: [
    withThemeByDataAttribute({
      themes: {
        dark: "dark",
        light: "light"
      },
      defaultTheme: "dark",
      attributeName: "data-theme"
    }),
    withIsolatedUiContext
  ],
  globalTypes: {
    motion: {
      description: "Enable production motion for motion-specific stories.",
      defaultValue: "disabled",
      toolbar: {
        icon: "play",
        items: [
          { value: "disabled", title: "Motion disabled" },
          { value: "enabled", title: "Motion enabled" }
        ]
      }
    }
  },
  parameters: {
    a11y: {
      test: "error"
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i
      }
    },
    options: {
      storySort: {
        order: ["Foundations", "Components", "Patterns", "Product examples"]
      }
    },
    backgrounds: {
      disable: true
    }
  }
}

export default preview
