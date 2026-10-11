// Compatibility for the JS-only bulk-memory lowering. Modern browsers keep
// their native operations. The fallback uses native TypedArray.set (memmove
// semantics for overlapping views) and logarithmic doubling for byte fills.
(function () {
  function index(value, length, defaultValue) {
    if (value === undefined) return defaultValue;
    value = Number(value) || 0;
    value = value < 0 ? Math.ceil(value) : Math.floor(value);
    return value < 0 ? Math.max(length + value, 0) : Math.min(value, length);
  }
  if (!Uint8Array.prototype.copyWithin) {
    Uint8Array.prototype.copyWithin = function (target, start, end) {
      var length = this.length;
      target = index(target, length, 0);
      start = index(start, length, 0);
      end = index(end, length, length);
      var count = Math.min(Math.max(end - start, 0), length - target);
      this.set(this.subarray(start, start + count), target);
      return this;
    };
  }
  if (!Uint8Array.prototype.fill) {
    Uint8Array.prototype.fill = function (value, start, end) {
      var length = this.length;
      start = index(start, length, 0);
      end = index(end, length, length);
      var count = Math.max(end - start, 0);
      if (count) {
        this[start] = value;
        var copied = 1;
        while (copied < count) {
          var next = Math.min(copied, count - copied);
          this.set(this.subarray(start, start + next), start + copied);
          copied += next;
        }
      }
      return this;
    };
  }
}());
