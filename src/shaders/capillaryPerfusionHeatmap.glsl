#version 300 es
precision highp float;

out vec4 fragColor;

uniform sampler2D u_frame;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_mode; // 0 = normal, 1 = heatmap
uniform float u_blanch; // 0..1 blanch intensity
uniform float u_refill; // 0..1 reperfusion recovery

float hemoglobinIndex(vec3 rgb){
  float r = max(rgb.r, 1e-4);
  float g = max(rgb.g, 1e-4);
  // A_Hb = log10(R/G)
  return log(r / g) / log(10.0);
}

vec3 heatColor(float t){
  // t 0..1: ischemic cyan/indigo -> perfused crimson/gold
  vec3 c0 = vec3(0.05, 0.18, 0.45);   // deep indigo
  vec3 c1 = vec3(0.10, 0.78, 0.82);   // cyan
  vec3 c2 = vec3(0.95, 0.80, 0.18);   // gold
  vec3 c3 = vec3(0.90, 0.16, 0.28);   // crimson
  if(t < 0.33) return mix(c0, c1, t/0.33);
  if(t < 0.66) return mix(c1, c2, (t-0.33)/0.33);
  return mix(c2, c3, (t-0.66)/0.34);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  // video textures often need Y flip in DOM upload; handle gracefully by sampling as-is
  vec2 texUv = vec2(uv.x, 1.0 - uv.y);
  vec4 tex = texture(u_frame, texUv);
  vec3 rgb = tex.rgb;

  float hb = hemoglobinIndex(rgb);
  // Normalize Hb index to a useful display range
  float hbNorm = clamp((hb + 0.15) / 0.35, 0.0, 1.0);

  // Simulate blanch/reperfusion effect overlay when driven by uniforms
  float perfusion = mix(hbNorm, hbNorm * (1.0 - 0.75*u_blanch) + 0.75*u_refill*hbNorm, 0.55);

  vec3 heat = heatColor(clamp(perfusion, 0.0, 1.0));

  // Blend original with heatmap
  float mode = clamp(u_mode, 0.0, 1.0);
  vec3 base = rgb;
  // Enhance contrast slightly
  base = pow(base, vec3(0.95));
  vec3 mixedCol = mix(base, heat, 0.72 * mode);

  // Add subtle pulsatile shimmer
  float pulse = 0.03 * sin(u_time * 3.0 + uv.y * 12.0) * mode;
  mixedCol += pulse * vec3(0.8, 0.2, 0.2);

  // Vignette for clinical focus
  vec2 d = uv - 0.5;
  float vig = 1.0 - smoothstep(0.35, 0.75, dot(d,d)*2.2);
  mixedCol *= 0.65 + 0.35*vig;

  fragColor = vec4(clamp(mixedCol, 0.0, 1.0), 1.0);
}
