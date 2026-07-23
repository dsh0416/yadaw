import { createRouter, createWebHashHistory } from "vue-router"
import PreferencesView from "../views/PreferencesView.vue"
import ProjectSettingsView from "../views/ProjectSettingsView.vue"
import StudioView from "../views/StudioView.vue"
import WelcomeView from "../views/WelcomeView.vue"

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      name: "welcome",
      component: WelcomeView
    },
    {
      path: "/studio",
      name: "studio",
      component: StudioView
    },
    {
      path: "/project-settings",
      name: "project-settings",
      component: ProjectSettingsView
    },
    {
      path: "/preferences",
      name: "preferences",
      component: PreferencesView
    }
  ]
})
