// Native check for pet.cpp, run with address + undefined-behaviour sanitizers.
#include <cassert>
#include <cmath>
#include <cstdio>
#include "pet.cpp"

int main() {
  const double H = HOUR;
  assert(value_now(100, 0, 5, 10 * H) == 50);
  assert(value_now(100, 0, 5, 30 * H) == 0);     // never negative
  assert(value_now(80, 5 * H, 5, 5 * H) == 80);  // no time passed
  assert(empty_at(100, 0, 5) == 20 * H);
  assert(std::isinf(empty_at(100, 0, 0)));       // not draining

  assert(charge_rate(20, 27, 1) == 5);           // a full battery lasts 20 h on a normal day
  assert(charge_rate(20, 30, 1) == 5);           // exactly 30 °C is not hot
  assert(charge_rate(20, 31, 1) == 7.5);
  assert(charge_rate(20, 31, 0) == 3.75);        // hot night
  assert(std::fabs(charge_rate(24, 27, 1) - 100.0 / 24) < 1e-12);  // you chose 24 h on the admin page
  assert(charge_rate(0, 27, 1) == 0);            // never divides by zero
  assert(mood_rate(12.5, 0, 1) == 8);
  assert(mood_rate(12.5, 1, 0) == 5.2);          // rainy night

  assert(brain_level(0) == 1 && brain_level(49) == 1);
  assert(brain_level(50) == 2 && brain_level(299) == 2);
  assert(brain_level(300) == 3);
  assert(lang_level(9) == 0 && lang_level(10) == 1 && lang_level(1000) == 5);

  int* w = weights_ptr();
  w[0] = 3;
  w[1] = 1;
  assert(pick_weighted(2, 0.0) == 0);
  assert(pick_weighted(2, 0.74) == 0);           // 3 of 4 parts belong to the first
  assert(pick_weighted(2, 0.76) == 1);
  assert(pick_weighted(0, 0.5) == -1);           // nothing to pick
  assert(pick_weighted(MAX_WEIGHTS + 1, 0.5) == -1);  // never reads past the buffer

  std::puts("pet.cpp: all checks passed");
}