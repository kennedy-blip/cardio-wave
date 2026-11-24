#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_bpm;
uniform float u_pwv;
uniform float u_systolic;
uniform float u_theme; // 0 obsidian, 1 daylight, 2 amber, 3 eco

#define PI 3.14159265359

mat2 rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }

float hash(vec2 p){
  p = fract(p*vec2(123.34, 456.21));
  p += dot(p, p+45.32);
  return fract(p.x*p.y);
}

float noise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
  vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}

float fbm(vec2 p){
  float v=0.0; float a=0.5;
  for(int i=0;i<5;i++){ v+=a*noise(p); p=rot(0.5)*p*2.0; a*=0.5; }
  return v;
}

vec3 palette(float t, float theme){
  if(theme > 2.5){ // eco - muted
    return mix(vec3(0.08,0.12,0.16), vec3(0.18,0.32,0.40), t);
  } else if(theme > 1.5){ // amber
    vec3 a = vec3(0.02,0.01,0.005);
    vec3 b = vec3(0.96,0.62,0.04);
    vec3 c = vec3(0.88,0.07,0.28);
    return mix(a, mix(b,c,smoothstep(0.4,0.9,t)), t);
  } else if(theme > 0.5){ // daylight
    vec3 a = vec3(0.94,0.96,0.98);
    vec3 b = vec3(0.75,0.12,0.22);
    vec3 c = vec3(0.08,0.35,0.62);
    return mix(a, mix(c,b,smoothstep(0.3,0.8,t)), 0.25 + 0.55*t);
  }
  // obsidian
  vec3 a = vec3(0.015,0.03,0.07);
  vec3 b = vec3(0.96,0.24,0.37); // arterial
  vec3 c = vec3(0.22,0.74,0.97); // venous
  vec3 d = vec3(0.06,0.72,0.51); // emerald
  vec3 mid = mix(c,b,smoothstep(0.25,0.75,t));
  return mix(a, mix(mid,d,0.15*smoothstep(0.6,1.0,t)), 0.15 + 0.85*t);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p = (gl_FragCoord.xy - 0.5*u_resolution.xy) / min(u_resolution.x, u_resolution.y);

  float bpm = clamp(u_bpm, 35.0, 180.0);
  float beatHz = bpm / 60.0;
  float pwv = clamp(u_pwv, 3.0, 15.0);
  float sys = clamp(u_systolic, 0.0, 1.0);

  // Cardiac phase: sawtooth + systolic bump
  float phase = fract(u_time * beatHz);
  float systolicBump = exp(-pow((phase - 0.18) / 0.08, 2.0));
  float dicrotic = 0.35 * exp(-pow((phase - 0.42) / 0.05, 2.0));
  float pulse = systolicBump + dicrotic;
  pulse *= (0.6 + 0.4*sys);

  // Radial arterial wave propagation
  float r = length(p);
  float waveSpeed = 0.25 + 0.06 * pwv;
  float radialWave = sin(18.0 * r - u_time * waveSpeed * 8.0 - pulse * 2.5);
  radialWave = 0.5 + 0.5 * radialWave;
  float waveRing = exp(-6.0 * abs(fract(r * 1.8 - u_time * beatHz * 0.8) - 0.5));

  // Flow field / vortex caustics
  vec2 q = p;
  q += 0.08 * vec2(fbm(p * 2.5 + u_time * 0.05), fbm(p * 2.5 - u_time * 0.04));
  float vortex = fbm(q * 3.0 + vec2(0.0, -u_time * 0.12 * (0.5 + 0.5*pulse)));
  float caustic = smoothstep(0.55, 0.85, vortex + 0.2 * radialWave);

  // Pressure contour lines (Wiggers-inspired)
  float contour = abs(sin((p.y * 8.0 + fbm(p*2.0 + u_time*0.03)*1.5) - pulse * 1.2));
  contour = smoothstep(0.02, 0.0, contour - 0.02);

  float intensity = 0.0;
  intensity += 0.35 * radialWave * waveRing;
  intensity += 0.30 * caustic;
  intensity += 0.12 * contour;
  intensity += 0.18 * pulse * exp(-3.0 * r);

  // Vignette
  float vig = 1.0 - smoothstep(0.4, 1.1, r);
  intensity *= (0.35 + 0.65 * vig);

  // Subtle grain
  float grain = (hash(uv * u_resolution.xy + u_time) - 0.5) * 0.03;

  vec3 col = palette(clamp(intensity, 0.0, 1.0), u_theme);
  // add venous/arterial split by angle
  float ang = atan(p.y, p.x);
  float split = 0.5 + 0.5 * sin(ang * 2.0 + u_time * 0.1);
  vec3 arterial = vec3(0.96, 0.24, 0.37);
  vec3 venous = vec3(0.22, 0.74, 0.97);
  if(u_theme > 1.5 && u_theme < 2.5) { arterial = vec3(0.96,0.62,0.04); venous = vec3(0.88,0.07,0.28); }
  if(u_theme > 0.5 && u_theme < 1.5) { arterial = vec3(0.75,0.12,0.22); venous = vec3(0.08,0.35,0.62); }
  col += 0.08 * mix(venous, arterial, split) * pulse * exp(-2.5*r);

  col += grain;
  col = clamp(col, 0.0, 1.0);

  // Theme base blending
  float alpha = 1.0;
  fragColor = vec4(col, alpha);
}
