// From https://github.com/w3c/webcodecs/tree/724b7d620519450c0c9630ab4eb97fe555f9007b/samples/video-decode-display
// in files render_2d, render_webgl, render_webgpu


/** Taille de la surface de rendu : bornée à la largeur affichée (CSS × DPR).
 * Une source 4000×2250 affichée dans 960 px n'a aucune raison de peindre 9 Mpx
 * (fill-rate + mémoire) ; le canvas CSS remet à l'échelle. */
function fitCanvasSize(frame, maxWidth) {
  const sw = frame.displayWidth || 1;
  const sh = frame.displayHeight || 1;
  if (!(maxWidth > 0) || sw <= maxWidth) return [sw, sh];
  const w = Math.round(maxWidth);
  return [w, Math.max(1, Math.round(sh * (w / sw)))];
}

class WebGLRenderer {
  #canvas = null;
  #maxWidth = 0;
  #ctx = null;
  #lastWidth = 0;
  #lastHeight = 0;
  // Tone mapping (HDR → SDR)
  #uToneMode = null;
  #uBt2020 = null;
  #uPeak = null;
  #toneMode = 0;
  #bt2020 = 0;
  #peak = 203;

  static vertexShaderSource = `
    attribute vec2 xy;

    varying highp vec2 uv;

    void main(void) {
      gl_Position = vec4(xy, 0.0, 1.0);
      // Map vertex coordinates (-1 to +1) to UV coordinates (0 to 1).
      // UV coordinates are Y-flipped relative to vertex coordinates.
      uv = vec2((1.0 + xy.x) / 2.0, (1.0 - xy.y) / 2.0);
    }
  `;

  static fragmentShaderSource = `
    precision highp float;
    varying highp vec2 uv;

    uniform sampler2D texture;
    uniform int uToneMode;   // 0 = SDR, 1 = PQ (HDR10), 2 = HLG
    uniform int uBt2020;     // 1 = convertir BT.2020 → BT.709
    uniform float uPeak;     // luminance cible SDR (nits)

    // ST 2084 (PQ) EOTF : code normalisé → luminance linéaire (1.0 = 10 000 nits)
    vec3 pqEotf(vec3 e) {
      const float m1 = 0.1593017578125;
      const float m2 = 78.84375;
      const float c1 = 0.8359375;
      const float c2 = 18.8515625;
      const float c3 = 18.6875;
      vec3 p = pow(max(e, vec3(0.0)), vec3(1.0 / m2));
      vec3 num = max(p - c1, vec3(0.0));
      vec3 den = max(c2 - c3 * p, vec3(1e-6));
      return pow(num / den, vec3(1.0 / m1));
    }

    // HLG (BT.2100) inverse OETF, approximation display-referred
    vec3 hlgEotf(vec3 e) {
      const float a = 0.17883277;
      const float b = 0.28466892;
      const float c = 0.55991073;
      vec3 low = (e * e) / 3.0;
      vec3 high = (exp((e - c) / a) + b) / 12.0;
      return mix(low, high, step(vec3(0.5), e));
    }

    // BT.2020 → BT.709 en linéaire
    vec3 bt2020To709(vec3 c) {
      return vec3(
        dot(c, vec3( 1.6605, -0.5876, -0.0728)),
        dot(c, vec3(-0.1246,  1.1329, -0.0083)),
        dot(c, vec3(-0.0182, -0.1006,  1.1187))
      );
    }

    // Courbe filmique (Narkowicz/ACES approx.) : compresse les hautes lumières
    vec3 aces(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }

    void main(void) {
      vec3 rgb = texture2D(texture, uv).rgb;
      if (uToneMode == 0) {
        gl_FragColor = vec4(rgb, 1.0);
        return;
      }
      vec3 lin = (uToneMode == 1)
        ? pqEotf(rgb) * 10000.0   // nits
        : hlgEotf(rgb) * 1000.0;  // pic nominal HLG
      if (uBt2020 == 1) lin = bt2020To709(lin);
      // Exposition vers la cible SDR, puis courbe filmique et encodage sRGB.
      lin = aces(lin / max(uPeak, 1.0));
      gl_FragColor = vec4(pow(lin, vec3(1.0 / 2.2)), 1.0);
    }
  `;

  constructor(canvas, type = "webgl2", existingCtx = null) {
    this.#canvas = canvas;
    // Réutilise le contexte déjà créé par la sonde : depuis Firefox 159, un
    // second getContext() sur un OffscreenCanvas peut jeter
    // (InvalidStateError). Un seul getContext par canvas, donc.
    const gl = (this.#ctx = existingCtx ?? canvas.getContext(type));

    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertexShader, WebGLRenderer.vertexShaderSource);
    gl.compileShader(vertexShader);
    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
      throw gl.getShaderInfoLog(vertexShader);
    }

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragmentShader, WebGLRenderer.fragmentShaderSource);
    gl.compileShader(fragmentShader);
    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
      throw gl.getShaderInfoLog(fragmentShader);
    }

    const shaderProgram = gl.createProgram();
    gl.attachShader(shaderProgram, vertexShader);
    gl.attachShader(shaderProgram, fragmentShader);
    gl.linkProgram(shaderProgram);
    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
      throw gl.getProgramInfoLog(shaderProgram);
    }
    gl.useProgram(shaderProgram);

    // Vertex coordinates, clockwise from bottom-left.
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1.0, -1.0, -1.0, +1.0, +1.0, +1.0, +1.0, -1.0]),
      gl.STATIC_DRAW,
    );

    const xyLocation = gl.getAttribLocation(shaderProgram, "xy");
    gl.vertexAttribPointer(xyLocation, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(xyLocation);

    // Create one texture to upload frames to.
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Valeurs brutes de la frame (pas de conversion couleur implicite du
    // navigateur) : indispensable pour que le shader voie le PQ/HLG.
    try { gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE); } catch {}

    // État couleur/HDR (tone mapping dans le fragment shader).
    this.#uToneMode = gl.getUniformLocation(shaderProgram, "uToneMode");
    this.#uBt2020 = gl.getUniformLocation(shaderProgram, "uBt2020");
    this.#uPeak = gl.getUniformLocation(shaderProgram, "uPeak");
    this.#toneMode = 0;
    this.#bt2020 = 0;
    this.#peak = 203;
  }

  /** Largeur d'affichage max (pixels physiques) ; 0 = pleine source. */
  setMaxDisplayWidth(px) {
    this.#maxWidth = Math.max(0, px | 0);
  }

  /** État couleur : { mode:'sdr'|'pq'|'hlg', bt2020:bool, peak:nits }. */
  setColorState(state) {
    if (!state) return;
    this.#toneMode = state.mode === "pq" ? 1 : state.mode === "hlg" ? 2 : 0;
    this.#bt2020 = state.bt2020 ? 1 : 0;
    if (state.peak > 0) this.#peak = state.peak;
  }

  draw(frame) {
    const [w, h] = fitCanvasSize(frame, this.#maxWidth);
    if (w !== this.#lastWidth || h !== this.#lastHeight) {
      this.#canvas.width = w;
      this.#canvas.height = h;
      this.#lastWidth = w;
      this.#lastHeight = h;
    }

    const gl = this.#ctx;
    const source = frame.source || frame.bitmap || frame;

    // Upload the frame.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    // Configure and draw the frame (tone mapping HDR → SDR).
    gl.uniform1i(this.#uToneMode, this.#toneMode);
    gl.uniform1i(this.#uBt2020, this.#bt2020);
    gl.uniform1f(this.#uPeak, this.#peak);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
  }

  clear() {
    const gl = this.#ctx;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

class WebGPURenderer {
  #canvas = null;
  #maxWidth = 0;
  #ctx = null;
  #lastWidth = 0;
  #lastHeight = 0;

  // Promise for `#start()`, WebGPU setup is asynchronous.
  #started = null;

  // WebGPU state shared between setup and drawing.
  #format = null;
  #device = null;
  #pipeline = null;
  #sampler = null;

  // Generates two triangles covering the whole canvas.
  static vertexShaderSource = `
    struct VertexOutput {
      @builtin(position) Position: vec4<f32>,
      @location(0) uv: vec2<f32>,
    }

    @vertex
    fn vert_main(@builtin(vertex_index) VertexIndex: u32) -> VertexOutput {
      var pos = array<vec2<f32>, 6>(
        vec2<f32>( 1.0,  1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 1.0,  1.0),
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(-1.0,  1.0)
      );

      var uv = array<vec2<f32>, 6>(
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 0.0)
      );

      var output : VertexOutput;
      output.Position = vec4<f32>(pos[VertexIndex], 0.0, 1.0);
      output.uv = uv[VertexIndex];
      return output;
    }
  `;

  // Samples the external texture using generated UVs.
  static fragmentShaderSource = `
    @group(0) @binding(1) var mySampler: sampler;
    @group(0) @binding(2) var myTexture: texture_external;

    @fragment
    fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
      return textureSampleBaseClampToEdge(myTexture, mySampler, uv);
    }
  `;

  constructor(canvas) {
    this.#canvas = canvas;
    this.#started = this.#start();
  }

  async #start() {
    const adapter = await navigator.gpu.requestAdapter();
    this.#device = await adapter.requestDevice();
    this.#format = navigator.gpu.getPreferredCanvasFormat();

    this.#ctx = this.#canvas.getContext("webgpu");
    this.#ctx.configure({
      device: this.#device,
      format: this.#format,
      alphaMode: "opaque",
    });

    this.#pipeline = this.#device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.#device.createShaderModule({
          code: WebGPURenderer.vertexShaderSource,
        }),
        entryPoint: "vert_main",
      },
      fragment: {
        module: this.#device.createShaderModule({
          code: WebGPURenderer.fragmentShaderSource,
        }),
        entryPoint: "frag_main",
        targets: [{ format: this.#format }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });

    // Default sampler configuration is nearset + clamp.
    this.#sampler = this.#device.createSampler({});
  }

  setMaxDisplayWidth(px) {
    this.#maxWidth = Math.max(0, px | 0);
  }

  async draw(frame) {
    // Don't try to draw any frames until the context is configured.
    await this.#started;

    const [w, h] = fitCanvasSize(frame, this.#maxWidth);
    if (w !== this.#lastWidth || h !== this.#lastHeight) {
      this.#canvas.width = w;
      this.#canvas.height = h;
      this.#lastWidth = w;
      this.#lastHeight = h;
    }

    const source = frame.source || frame.bitmap || frame;

    const uniformBindGroup = this.#device.createBindGroup({
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: this.#sampler },
        {
          binding: 2,
          resource: this.#device.importExternalTexture({ source }),
        },
      ],
    });

    const commandEncoder = this.#device.createCommandEncoder();
    const textureView = this.#ctx.getCurrentTexture().createView();
    const renderPassDescriptor = {
      colorAttachments: [
        {
          view: textureView,
          clearValue: [1.0, 0.0, 0.0, 1.0],
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setPipeline(this.#pipeline);
    passEncoder.setBindGroup(0, uniformBindGroup);
    passEncoder.draw(6, 1, 0, 0);
    passEncoder.end();
    this.#device.queue.submit([commandEncoder.finish()]);
  }

  async clear() {
    await this.#started;
    const commandEncoder = this.#device.createCommandEncoder();
    const textureView = this.#ctx.getCurrentTexture().createView();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: [0.0, 0.0, 0.0, 1.0],
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    passEncoder.end();
    this.#device.queue.submit([commandEncoder.finish()]);
  }
}

class Canvas2DRenderer {
  #canvas = null;
  #maxWidth = 0;
  #ctx = null;
  #lastWidth = 0;
  #lastHeight = 0;

  constructor(canvas, existingCtx = null) {
    this.#canvas = canvas;
    this.#ctx = existingCtx ?? canvas.getContext("2d");
  }

  setMaxDisplayWidth(px) {
    this.#maxWidth = Math.max(0, px | 0);
  }

  draw(frame) {
    const [w, h] = fitCanvasSize(frame, this.#maxWidth);
    if (w !== this.#lastWidth || h !== this.#lastHeight) {
      this.#canvas.width = w;
      this.#canvas.height = h;
      this.#lastWidth = w;
      this.#lastHeight = h;
    }
    // Destination = surface réelle du canvas (déjà bornée) : le navigateur
    // redimensionne ensuite via CSS.
    this.#ctx.drawImage(frame.source || frame.bitmap || frame, 0, 0, w, h);
  }

  clear() {
    this.#ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
  }
}

export { WebGLRenderer, WebGPURenderer, Canvas2DRenderer };
