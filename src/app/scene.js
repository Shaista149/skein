import * as THREE from 'three';

// SCENE
export function initScene(canvas) {
  // preserveDrawingBuffer:true so the eyedropper's canvas-sampling fallback
  // (used when the browser has no native EyeDropper API) can read back
  // whatever was last painted to the canvas, rather than racing a buffer
  // that WebGL is otherwise free to clear before the read happens.
  const renderer = new THREE.WebGLRenderer({canvas, antialias:true, preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  if (renderer.toneMapping !== undefined) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
  }
  if (renderer.outputEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
  if (renderer.outputColorSpace !== undefined) renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x18120e);
  scene.fog = new THREE.FogExp2(0x18120e, 0.018);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 500);

  // Lighting rig - matched to v6's warm look
  scene.add(new THREE.AmbientLight(0xf7f2eb, 0.38));
  const key = new THREE.DirectionalLight(0xfff5e0, 1.55);
  key.position.set(18,38,22); key.castShadow=true;
  key.shadow.camera.near=0.1; key.shadow.camera.far=200;
  key.shadow.camera.left=key.shadow.camera.bottom=-40;
  key.shadow.camera.right=key.shadow.camera.top=40;
  key.shadow.mapSize.set(2048,2048);
  key.shadow.bias=-0.0003;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc8d8ff, 0.38);
  fill.position.set(-22,8,-18); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffe0c0, 0.28);
  rim.position.set(2,-22,-18); scene.add(rim);
  const bounce = new THREE.PointLight(0xf7c890, 0.32, 90);
  bounce.position.set(0,-28,0); scene.add(bounce);
  const top = new THREE.DirectionalLight(0xffffff, 0.12);
  top.position.set(0,60,0); scene.add(top);

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  let animId = null;
  function start() {
    function loop() { animId=requestAnimationFrame(loop); renderer.render(scene,camera); }
    loop();
  }

  return {renderer, scene, camera, start};
}

export function initOrbit(camera, canvas) {
  let dragging=false, lastX=0, lastY=0;
  let theta=0.4, phi=1.2, radius=40;
  const target = new THREE.Vector3();
  const MIN_PHI=0.05, MAX_PHI=Math.PI-0.05, MIN_R=1, MAX_R=400;
  // Suspended while a marker drag is in progress (see the marker-drag
  // section below) - the canvas mousedown that starts a marker drag has
  // already set `dragging` true here (this listener was registered first
  // and fires first), so rotation is blocked out here in the move handlers
  // instead, rather than trying to unwind `dragging` itself.
  let suspended = false;

  function update() {
    camera.position.set(
      target.x + radius*Math.sin(phi)*Math.sin(theta),
      target.y + radius*Math.cos(phi),
      target.z + radius*Math.sin(phi)*Math.cos(theta)
    );
    camera.lookAt(target);
  }

  canvas.addEventListener('mousedown',e=>{dragging=true;lastX=e.clientX;lastY=e.clientY;e.preventDefault();});
  window.addEventListener('mousemove',e=>{
    if(!dragging||suspended)return;
    theta -= (e.clientX-lastX)*0.008;
    phi = Math.max(MIN_PHI,Math.min(MAX_PHI,phi-(e.clientY-lastY)*0.008));
    lastX=e.clientX; lastY=e.clientY; update();
  });
  window.addEventListener('mouseup',()=>dragging=false);
  canvas.addEventListener('wheel',e=>{
    e.preventDefault();
    radius = Math.max(MIN_R,Math.min(MAX_R,radius*(1+e.deltaY*0.001)));
    update();
  },{passive:false});

  let lastTD=0;
  canvas.addEventListener('touchstart',e=>{
    if(e.touches.length===1){dragging=true;lastX=e.touches[0].clientX;lastY=e.touches[0].clientY;}
    if(e.touches.length===2){dragging=false;lastTD=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);}
  },{passive:true});
  canvas.addEventListener('touchmove',e=>{
    if(suspended)return;
    e.preventDefault();
    if(e.touches.length===1&&dragging){
      theta-=(e.touches[0].clientX-lastX)*0.008;
      phi=Math.max(MIN_PHI,Math.min(MAX_PHI,phi-(e.touches[0].clientY-lastY)*0.008));
      lastX=e.touches[0].clientX;lastY=e.touches[0].clientY;update();
    }
    if(e.touches.length===2){
      const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
      radius=Math.max(MIN_R,Math.min(MAX_R,radius*(1-(d-lastTD)*0.005)));
      lastTD=d;update();
    }
  },{passive:false});
  canvas.addEventListener('touchend',()=>dragging=false);

  update();
  return {
    setSuspended(v) { suspended = !!v; },
    fitTo(pts) {
      if (!pts || pts.length === 0) return;
      let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
      // A single non-finite point (a stray NaN/Infinity from a degenerate
      // rotation somewhere upstream - a zero-length axis, a divide-by-zero)
      // used to poison the whole box: Math.min/max propagate NaN through
      // every comparison after it, so target and radius went NaN too, and
      // the camera would silently jump somewhere nonsensical with no error.
      // Skipping non-finite points here means one bad node just gets left
      // out of the framing instead of breaking it for the whole model.
      let badCount = 0, firstBadIdx = -1;
      for (let i=0;i<pts.length;i+=3){
        const x=pts[i], y=pts[i+1], z=pts[i+2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          badCount++; if (firstBadIdx<0) firstBadIdx = i/3;
          continue;
        }
        minX=Math.min(minX,x);maxX=Math.max(maxX,x);
        minY=Math.min(minY,y);maxY=Math.max(maxY,y);
        minZ=Math.min(minZ,z);maxZ=Math.max(maxZ,z);
      }
      if (badCount) console.warn(`fitTo: ${badCount} non-finite point(s), first at node index ${firstBadIdx} - skipped for framing`);
      if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return; // every point was bad - keep the last good framing rather than snapping to garbage
      target.set((minX+maxX)/2,(minY+maxY)/2,(minZ+maxZ)/2);
      const size=Math.max(maxX-minX,maxY-minY,maxZ-minZ,0.1);
      radius = size * 2.2;
      update();
    }
  };
}