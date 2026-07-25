import { createRouter, createWebHashHistory } from "vue-router"

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      name: "welcome",
      component: () => import("../views/WelcomeView.vue")
    },
    {
      path: "/studio",
      name: "studio",
      component: () => import("../views/StudioView.vue")
    },
    {
      path: "/project-settings",
      name: "project-settings",
      component: () => import("../views/ProjectSettingsView.vue")
    },
    {
      path: "/preferences",
      name: "preferences",
      component: () => import("../views/PreferencesView.vue")
    }
  ]
})
