function getInspectable(child) {
  let el = child;
  while (el) {
    if (el.components && el.components.tags && el.components.tags.data.inspectable) return el;
    if (
      el.attributes &&
      el.attributes.tags &&
      el.attributes.tags.value &&
      el.attributes.tags.value.indexOf("inspectable") !== -1
    )
      return el;
    el = el.parentNode;
  }
  return null;
}

AFRAME.registerComponent("inspect-button", {
  init() {
    this.inspectable = getInspectable(this.el);
    if (!this.inspectable) {
      console.error("You put an inspect button but I could not find what you want to inspect.", this.el);
      return;
    }
    this.el.object3D.addEventListener("holdable-button-down", () => {
      this.el.sceneEl.systems["hubs-systems"].cameraSystem.inspect(this.inspectable.object3D);
    });
    this.el.object3D.addEventListener("holdable-button-up", () => {
      this.el.sceneEl.systems["hubs-systems"].cameraSystem.uninspect();
    });
  }
});
