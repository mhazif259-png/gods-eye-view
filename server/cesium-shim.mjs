/** No Cesium build plugin is needed when only the API plugins are registered. */
export default function cesium() {
  return { name: 'gev-cesium-shim' };
}
