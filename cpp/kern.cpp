// The one hot loop of the brain_v4 generator, in WebAssembly SIMD: 4 multiply-adds per instruction.
// Built like ohm-api's pet.wasm (clang++ --target=wasm32, no libc), plus -msimd128 and memory imported from JS,
// which places the weights and buffers. This only does arithmetic.
#include <wasm_simd128.h>

extern "C" {

// OUT[m, rows] = X[m, cols] . W^T + b, with W [rows, cols] row-major (PyTorch's Linear layout); b may be null (0).
void linear(const float* W, const float* b, const float* X, int m, int cols, int rows, float* OUT) {
  for (int r = 0; r < rows; r++) {
    const float* w = W + r * cols;
    const float bias = b ? b[r] : 0.0f;
    for (int v = 0; v < m; v++) {
      const float* x = X + v * cols;
      v128_t a0 = wasm_f32x4_splat(0.0f), a1 = wasm_f32x4_splat(0.0f);
      int c = 0;
      for (; c + 8 <= cols; c += 8) {
        a0 = wasm_f32x4_add(a0, wasm_f32x4_mul(wasm_v128_load(w + c), wasm_v128_load(x + c)));
        a1 = wasm_f32x4_add(a1, wasm_f32x4_mul(wasm_v128_load(w + c + 4), wasm_v128_load(x + c + 4)));
      }
      for (; c + 4 <= cols; c += 4) a0 = wasm_f32x4_add(a0, wasm_f32x4_mul(wasm_v128_load(w + c), wasm_v128_load(x + c)));
      const v128_t s = wasm_f32x4_add(a0, a1);
      float t = wasm_f32x4_extract_lane(s, 0) + wasm_f32x4_extract_lane(s, 1) + wasm_f32x4_extract_lane(s, 2) +
                wasm_f32x4_extract_lane(s, 3);
      for (; c < cols; c++) t += w[c] * x[c];
      OUT[v * rows + r] = bias + t;
    }
  }
}

}
