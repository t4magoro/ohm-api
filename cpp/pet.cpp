// Ohm's C++ code, compiled to WebAssembly.
// Rule for this file: numbers in, numbers out, no heap. It's built with -nostdlib,
// so there's no malloc to call. Using new or malloc fails the build.

#ifdef __wasm__
#define EXPORT(name) extern "C" __attribute__((export_name(name)))
#else
#define EXPORT(name) extern "C"  // native build for pet_test.cpp
#endif

EXPORT("add")
int add(int a, int b) { return a + b; }