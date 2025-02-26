import nextTick from "../utils/next-tick";
import { mapMaterials } from "../utils/material-utils";
import SketchfabZipWorker from "../workers/sketchfab-zip.worker.js";
import MobileStandardMaterial from "../materials/MobileStandardMaterial";
import { textureLoader } from "../utils/media-utils";
import { getCustomGLTFParserURLResolver } from "../utils/media-url-utils";
import { promisifyWorker } from "../utils/promisify-worker.js";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";
import { disposeNode, cloneObject3D } from "../utils/three-utils";

THREE.Mesh.prototype.raycast = acceleratedRaycast;

class GLTFCache {
  cache = new Map();

  set(src, gltf) {
    this.cache.set(src, {
      gltf,
      count: 0
    });
    return this.retain(src);
  }

  has(src) {
    return this.cache.has(src);
  }

  get(src) {
    return this.cache.get(src);
  }

  retain(src) {
    const cacheItem = this.cache.get(src);
    cacheItem.count++;
    return cacheItem;
  }

  release(src) {
    const cacheItem = this.cache.get(src);

    if (!cacheItem) {
      console.error(`Releasing uncached gltf ${src}`);
      return;
    }

    cacheItem.count--;
    if (cacheItem.count <= 0) {
      cacheItem.gltf.scene.traverse(disposeNode);
      this.cache.delete(src);
    }
  }
}
const gltfCache = new GLTFCache();
const inflightGltfs = new Map();

const extractZipFile = promisifyWorker(new SketchfabZipWorker());

function defaultInflator(el, componentName, componentData) {
  if (!AFRAME.components[componentName]) {
    throw new Error(`Inflator failed. "${componentName}" component does not exist.`);
  }
  if (AFRAME.components[componentName].multiple && Array.isArray(componentData)) {
    for (let i = 0; i < componentData.length; i++) {
      el.setAttribute(componentName + "__" + i, componentData[i]);
    }
  } else {
    el.setAttribute(componentName, componentData);
  }
}

AFRAME.GLTFModelPlus = {
  // eslint-disable-next-line no-unused-vars
  components: {},
  registerComponent(componentKey, componentName, inflator) {
    inflator = inflator || defaultInflator;
    AFRAME.GLTFModelPlus.components[componentKey] = { inflator, componentName };
  }
};

function generateMeshBVH(object3D) {
  object3D.traverse(obj => {
    // note that we might already have a bounds tree if this was a clone of an object with one
    const hasBufferGeometry = obj.isMesh && obj.geometry.isBufferGeometry;
    const hasBoundsTree = hasBufferGeometry && obj.geometry.boundsTree;
    if (hasBufferGeometry && !hasBoundsTree && obj.geometry.attributes.position) {
      const geo = obj.geometry;
      const triCount = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
      // only bother using memory and time making a BVH if there are a reasonable number of tris,
      // and if there are too many it's too painful and large to tolerate doing it (at least until
      // we put this in a web worker)
      if (triCount > 1000 && triCount < 1000000) {
        // note that bounds tree construction creates an index as a side effect if one doesn't already exist
        geo.boundsTree = new MeshBVH(obj.geometry, { strategy: 0, maxDepth: 30 });
      }
    }
  });
}

function cloneGltf(gltf) {
  return {
    animations: gltf.scene.animations,
    scene: cloneObject3D(gltf.scene)
  };
}

function getHubsComponents(node) {
  const hubsComponents =
    node.userData.gltfExtensions &&
    (node.userData.gltfExtensions.MOZ_hubs_components || node.userData.gltfExtensions.HUBS_components);

  // We can remove support for legacy components when our environment, avatar and interactable models are
  // updated to match Spoke output.
  const legacyComponents = node.userData.components;

  return hubsComponents || legacyComponents;
}

/// Walks the tree of three.js objects starting at the given node, using the GLTF data
/// and template data to construct A-Frame entities and components when necessary.
/// (It's unnecessary to construct entities for subtrees that have no component data
/// or templates associated with any of their nodes.)
///
/// Returns the A-Frame entity associated with the given node, if one was constructed.
const inflateEntities = function(indexToEntityMap, node, templates, isRoot, modelToWorldScale = 1) {
  // TODO: Remove this once we update the legacy avatars to the new node names
  if (node.name === "Chest") {
    node.name = "Spine";
  } else if (node.name === "Root Scene") {
    node.name = "AvatarRoot";
  } else if (node.name === "Bot_Skinned") {
    node.name = "AvatarMesh";
  }

  // inflate subtrees first so that we can determine whether or not this node needs to be inflated
  const childEntities = [];
  const children = node.children.slice(0); // setObject3D mutates the node's parent, so we have to copy
  for (const child of children) {
    const el = inflateEntities(indexToEntityMap, child, templates);
    if (el) {
      childEntities.push(el);
    }
  }

  const entityComponents = getHubsComponents(node);

  const nodeHasBehavior = !!entityComponents || node.name in templates;
  if (!nodeHasBehavior && !childEntities.length && !isRoot) {
    return null; // we don't need an entity for this node
  }

  const el = document.createElement("a-entity");
  el.append.apply(el, childEntities);

  // Remove invalid CSS class name characters.
  const className = (node.name || node.uuid).replace(/[^\w-]/g, "");
  el.classList.add(className);

  // AFRAME rotation component expects rotations in YXZ, convert it
  if (node.rotation.order !== "YXZ") {
    node.rotation.setFromQuaternion(node.quaternion, "YXZ");
  }

  // Copy over the object's transform to the THREE.Group and reset the actual transform of the Object3D
  // all updates to the object should be done through the THREE.Group wrapper
  el.object3D.position.copy(node.position);
  el.object3D.rotation.copy(node.rotation);
  el.object3D.scale.copy(node.scale).multiplyScalar(modelToWorldScale);
  el.object3D.matrixNeedsUpdate = true;

  node.matrixAutoUpdate = false;
  node.matrix.identity();
  node.matrix.decompose(node.position, node.rotation, node.scale);

  el.setObject3D(node.type.toLowerCase(), node);
  if (entityComponents && "nav-mesh" in entityComponents) {
    el.setObject3D("mesh", node);
  }

  // Set the name of the `THREE.Group` to match the name of the node,
  // so that templates can be attached to the correct AFrame entity.
  el.object3D.name = node.name;

  // Set the uuid of the `THREE.Group` to match the uuid of the node,
  // so that `THREE.PropertyBinding` will find (and later animate)
  // the group. See `PropertyBinding.findNode`:
  // https://github.com/mrdoob/three.js/blob/dev/src/animation/PropertyBinding.js#L211
  el.object3D.uuid = node.uuid;
  node.uuid = THREE.Math.generateUUID();

  if (node.animations) {
    // Pass animations up to the group object so that when we can pass the group as
    // the optional root in `THREE.AnimationMixer.clipAction` and use the hierarchy
    // preserved under the group (but not the node). Otherwise `clipArray` will be
    // `null` in `THREE.AnimationClip.findByName`.
    node.parent.animations = node.animations;
  }

  const gltfIndex = node.userData.gltfIndex;
  if (gltfIndex !== undefined) {
    indexToEntityMap[gltfIndex] = el;
  }

  return el;
};

function inflateComponents(inflatedEntity, indexToEntityMap) {
  inflatedEntity.object3D.traverse(object3D => {
    const entityComponents = getHubsComponents(object3D);
    const el = object3D.el;

    if (entityComponents && el) {
      for (const prop in entityComponents) {
        if (entityComponents.hasOwnProperty(prop) && AFRAME.GLTFModelPlus.components.hasOwnProperty(prop)) {
          const { componentName, inflator } = AFRAME.GLTFModelPlus.components[prop];
          inflator(el, componentName, entityComponents[prop], entityComponents, indexToEntityMap);
        }
      }
    }
  });
}

function attachTemplate(root, name, templateRoot) {
  const targetEls = root.querySelectorAll("." + name);
  for (const el of targetEls) {
    const root = templateRoot.cloneNode(true);
    // Merge root element attributes with the target element
    for (const { name, value } of root.attributes) {
      el.setAttribute(name, value);
    }

    // Append all child elements
    while (root.children.length > 0) {
      el.appendChild(root.children[0]);
    }
  }
}

function runMigration(version, json) {
  if (version < 2) {
    //old heightfields will be on the same node as the nav-mesh, delete those
    const oldHeightfieldNode = json.nodes.find(node => {
      let components = null;
      if (node.extensions && node.extensions.MOZ_hubs_components) {
        components = node.extensions.MOZ_hubs_components;
      } else if (node.extensions && node.extensions.HUBS_components) {
        components = node.extensions.HUBS_components;
      }
      return components && components.heightfield && components["nav-mesh"];
    });
    if (oldHeightfieldNode) {
      if (oldHeightfieldNode.extensions.MOZ_hubs_components) {
        delete oldHeightfieldNode.extensions.MOZ_hubs_components.heightfield;
      } else if (oldHeightfieldNode.extensions.HUBS_components) {
        delete oldHeightfieldNode.extensions.HUBS_components.heightfield;
      }
    }
  }
}

export async function loadGLTF(src, contentType, preferredTechnique, onProgress, jsonPreprocessor) {
  let gltfUrl = src;
  let fileMap;

  if (contentType && (contentType.includes("model/gltf+zip") || contentType.includes("application/x-zip-compressed"))) {
    fileMap = await extractZipFile(gltfUrl);
    gltfUrl = fileMap["scene.gtlf"];
  }

  const loadingManager = new THREE.LoadingManager();
  loadingManager.setURLModifier(getCustomGLTFParserURLResolver(gltfUrl));
  const gltfLoader = new THREE.GLTFLoader(loadingManager);

  const parser = await new Promise((resolve, reject) => gltfLoader.createParser(gltfUrl, resolve, onProgress, reject));

  parser.textureLoader = textureLoader;

  if (jsonPreprocessor) {
    parser.json = jsonPreprocessor(parser.json);
  }

  let version = 0;
  if (
    parser.json.extensions &&
    parser.json.extensions.MOZ_hubs_components &&
    parser.json.extensions.MOZ_hubs_components.hasOwnProperty("version")
  ) {
    version = parser.json.extensions.MOZ_hubs_components.version;
  }
  runMigration(version, parser.json);

  const materials = parser.json.materials;
  if (materials) {
    for (let i = 0; i < materials.length; i++) {
      const material = materials[i];

      if (
        material.extensions &&
        material.extensions.MOZ_alt_materials &&
        material.extensions.MOZ_alt_materials[preferredTechnique] !== undefined
      ) {
        const altMaterialIndex = material.extensions.MOZ_alt_materials[preferredTechnique];
        materials[i] = materials[altMaterialIndex];
      }
    }
  }

  const nodes = parser.json.nodes;

  if (nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];

      if (!node.extras) {
        node.extras = {};
      }

      node.extras.gltfIndex = i;
    }
  }

  const gltf = await new Promise(parser.parse.bind(parser));

  gltf.scene.traverse(object => {
    // GLTFLoader sets matrixAutoUpdate on animated objects, we want to keep the defaults
    object.matrixAutoUpdate = THREE.Object3D.DefaultMatrixAutoUpdate;

    object.material = mapMaterials(object, material => {
      if (material.isMeshStandardMaterial && preferredTechnique === "KHR_materials_unlit") {
        return MobileStandardMaterial.fromStandardMaterial(material);
      }

      return material;
    });
  });

  if (fileMap) {
    // The GLTF is now cached as a THREE object, we can get rid of the original blobs
    Object.keys(fileMap).forEach(URL.revokeObjectURL);
  }

  gltf.scene.animations = gltf.animations;

  return gltf;
}

export async function loadModel(src, contentType = null, useCache = false, jsonPreprocessor = null) {
  const preferredTechnique =
    window.APP && window.APP.quality === "low" ? "KHR_materials_unlit" : "pbrMetallicRoughness";

  if (useCache) {
    if (gltfCache.has(src)) {
      gltfCache.retain(src);
      return cloneGltf(gltfCache.get(src).gltf);
    } else {
      if (inflightGltfs.has(src)) {
        const gltf = await inflightGltfs.get(src);
        gltfCache.retain(src);
        return cloneGltf(gltf);
      } else {
        const promise = loadGLTF(src, contentType, preferredTechnique, null, jsonPreprocessor);
        inflightGltfs.set(src, promise);
        const gltf = await promise;
        inflightGltfs.delete(src);
        gltfCache.set(src, gltf);
        return cloneGltf(gltf);
      }
    }
  } else {
    return loadGLTF(src, contentType, preferredTechnique, null, jsonPreprocessor);
  }
}

function resolveAsset(src) {
  // If the src attribute is a selector, get the url from the asset item.
  if (src && src.charAt(0) === "#") {
    const assetEl = document.getElementById(src.substring(1));
    return assetEl.getAttribute("src");
  }
  return src;
}

/**
 * Loads a GLTF model, optionally recursively "inflates" the child nodes of a model into a-entities and sets
 * whitelisted components on them if defined in the node's extras.
 * @namespace gltf
 * @component gltf-model-plus
 */
AFRAME.registerComponent("gltf-model-plus", {
  schema: {
    src: { type: "string" },
    contentType: { type: "string" },
    useCache: { default: true },
    inflate: { default: false },
    batch: { default: false },
    modelToWorldScale: { type: "number", default: 1 }
  },

  init() {
    // This can be set externally if a consumer wants to do some node preprocssing.
    this.jsonPreprocessor = null;

    this.loadTemplates();
  },

  update() {
    this.applySrc(resolveAsset(this.data.src), this.data.contentType);
  },

  remove() {
    if (this.data.batch && this.model) {
      this.el.sceneEl.systems["hubs-systems"].batchManagerSystem.removeObject(this.el.object3DMap.mesh);
    }
    const src = resolveAsset(this.data.src);
    if (src) {
      gltfCache.release(src);
    }
  },

  loadTemplates() {
    this.templates = {};
    this.el.querySelectorAll(":scope > template").forEach(templateEl => {
      const root = document.importNode(templateEl.firstElementChild || templateEl.content.firstElementChild, true);
      this.templates[templateEl.getAttribute("data-name")] = root;
    });
  },

  async applySrc(src, contentType) {
    try {
      if (src === this.lastSrc) return;

      const lastSrc = this.lastSrc;
      this.lastSrc = src;

      if (!src) {
        if (this.inflatedEl) {
          console.warn("gltf-model-plus set to an empty source, unloading inflated model.");
          this.disposeLastInflatedEl();
        }
        return;
      }

      this.el.emit("model-loading");
      const gltf = await loadModel(src, contentType, this.data.useCache, this.jsonPreprocessor);

      // If we started loading something else already
      // TODO: there should be a way to cancel loading instead
      if (src != this.lastSrc) return;

      // If we had inflated something already before, clean that up
      this.disposeLastInflatedEl();

      this.model = gltf.scene || gltf.scenes[0];

      if (this.data.batch) {
        this.el.sceneEl.systems["hubs-systems"].batchManagerSystem.addObject(this.model);
      }

      if (gltf.animations.length > 0) {
        this.el.setAttribute("animation-mixer", {});
        this.el.components["animation-mixer"].initMixer(this.model.animations);
      } else {
        generateMeshBVH(this.model);
      }

      const indexToEntityMap = {};

      let object3DToSet = this.model;
      if (
        this.data.inflate &&
        (this.inflatedEl = inflateEntities(
          indexToEntityMap,
          this.model,
          this.templates,
          true,
          this.data.modelToWorldScale
        ))
      ) {
        this.el.appendChild(this.inflatedEl);

        object3DToSet = this.inflatedEl.object3D;
        // TODO: Still don't fully understand the lifecycle here and how it differs between browsers, we should dig in more
        // Wait one tick for the appended custom elements to be connected before attaching templates
        await nextTick();
        if (src != this.lastSrc) return; // TODO: there must be a nicer pattern for this

        inflateComponents(this.inflatedEl, indexToEntityMap);

        for (const name in this.templates) {
          attachTemplate(this.el, name, this.templates[name]);
        }
      }

      // The call to setObject3D below recursively clobbers any `el` backreferences to entities
      // in the entire inflated entity graph to point to `object3DToSet`.
      //
      // We don't want those overwritten, since lots of code assumes `object3d.el` points to the relevant
      // A-Frame entity for that three.js object, so we back them up and re-wire them here. If we didn't do
      // this, all the `el` properties on these object3ds would point to the `object3DToSet` which is either
      // the model or the root GLTF inflated entity.
      const rewires = [];

      object3DToSet.traverse(o => {
        const el = o.el;
        if (el) rewires.push(() => (o.el = el));
      });

      const environmentMapComponent = this.el.sceneEl.components["environment-map"];

      if (environmentMapComponent) {
        environmentMapComponent.applyEnvironmentMap(object3DToSet);
      }

      if (lastSrc) {
        gltfCache.release(lastSrc);
      }
      this.el.setObject3D("mesh", object3DToSet);

      rewires.forEach(f => f());

      this.el.emit("model-loaded", { format: "gltf", model: this.model });
    } catch (e) {
      gltfCache.release(src);
      console.error("Failed to load glTF model", e, this);
      this.el.emit("model-error", { format: "gltf", src });
    }
  },

  disposeLastInflatedEl() {
    if (this.inflatedEl) {
      this.inflatedEl.parentNode.removeChild(this.inflatedEl);

      this.inflatedEl.object3D.traverse(x => {
        if (x.material && x.material.dispose) {
          x.material.dispose();
        }

        if (x.geometry) {
          if (x.geometry.dispose) {
            x.geometry.dispose();
          }

          x.geometry.boundsTree = null;
        }
      });

      delete this.inflatedEl;

      this.el.removeAttribute("animation-mixer");
    }
  }
});
