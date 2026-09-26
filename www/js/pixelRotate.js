// Turning a pixel-art picture by any angle WITHOUT blending a single pixel.
//
// The two-finger camera rotation used to turn the canvas context and draw
// the artwork through it. Canvas 2D resamples a rotated image with bilinear
// filtering (imageSmoothingEnabled only switches it to a different blend,
// never off for rotation) and anti-aliases the rotated edges -- so a turned
// view showed every sprite pixel smeared into its neighbours. Exactly what
// the rest of the app does not allow.
//
// So a turned view is drawn here instead, by the GPU with NEAREST sampling
// and anti-aliasing off: every device pixel on screen is mapped back through
// the rotation to ONE texel of the picture and takes that texel's colour,
// unblended. What reaches the screen is the picture's own pixels, turned --
// each a small rotated block of solid colour with hard stair-stepped edges,
// the way a pixel-art sprite looks when an artist rotates it by hand. The
// result is copied onto the 2D canvas 1:1, so nothing resamples it after.
//
// The caller composes the picture at its own resolution first (one texel per
// scene pixel: checkerboard, artwork, outline, veil), which is also what
// keeps the upload per frame small. Where WebGL is unavailable, draw()
// returns false and the caller keeps its old path.

const VERTEX = `
attribute vec2 a_corner;
uniform vec4 u_rect;      // x, y, width, height of the unturned picture, device px
uniform vec2 u_centre;    // what it turns about, device px
uniform vec2 u_turn;      // cos, sin
uniform vec2 u_view;      // the canvas, device px
varying vec2 v_uv;
void main() {
  vec2 p = u_rect.xy + a_corner * u_rect.zw - u_centre;
  vec2 q = u_centre + vec2(p.x * u_turn.x - p.y * u_turn.y, p.x * u_turn.y + p.y * u_turn.x);
  gl_Position = vec4(q.x / u_view.x * 2.0 - 1.0, 1.0 - q.y / u_view.y * 2.0, 0.0, 1.0);
  v_uv = a_corner;
}`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D u_picture;
varying vec2 v_uv;
void main() {
  gl_FragColor = texture2D(u_picture, v_uv);
}`;

export class NearestRotator {
  constructor() {
    this.canvas = null;
    this.gl = null;
    this.failed = false;
  }

  init() {
    if (this.gl || this.failed) return Boolean(this.gl);
    try {
      this.canvas = document.createElement('canvas');
      const gl = this.canvas.getContext('webgl', {
        antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true,
      });
      if (!gl) throw new Error('no webgl');
      const shader = (type, source) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);

      const corners = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
      const at = gl.getAttribLocation(program, 'a_corner');
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);

      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // NEAREST both ways: a texel is taken whole or not at all.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

      this.uniforms = {
        rect: gl.getUniformLocation(program, 'u_rect'),
        centre: gl.getUniformLocation(program, 'u_centre'),
        turn: gl.getUniformLocation(program, 'u_turn'),
        view: gl.getUniformLocation(program, 'u_view'),
      };
      this.gl = gl;
      return true;
    } catch {
      this.failed = true;
      this.gl = null;
      return false;
    }
  }

  // Draws `picture` (a canvas) onto the 2D context `ctx`, as the rectangle
  // (x, y, width, height) in DEVICE px turned by `angle` about (cx, cy).
  // Returns false when it cannot, so the caller can fall back.
  draw(ctx, picture, { x, y, width, height, angle, cx, cy }) {
    if (!this.init()) return false;
    const { gl, canvas } = this;
    const target = ctx.canvas;
    if (canvas.width !== target.width) canvas.width = target.width;
    if (canvas.height !== target.height) canvas.height = target.height;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture);
    gl.uniform4f(this.uniforms.rect, x, y, width, height);
    gl.uniform2f(this.uniforms.centre, cx, cy);
    gl.uniform2f(this.uniforms.turn, Math.cos(angle), Math.sin(angle));
    gl.uniform2f(this.uniforms.view, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 1:1 onto the 2D canvas, in raw device pixels: a copy, not a resample.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0);
    ctx.restore();
    return true;
  }
}
