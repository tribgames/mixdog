// WinRT projection stays in PowerShell; this bridge needs no SDK or extra package.
public static class MixWindowGraphicsCapture {
  [ComImport, Guid("30d5a829-7fa4-4026-83bb-d75bae4ea99e"),
    InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
  interface CaptureClosable {
    void Close();
  }
  public static void Close(object resource) { ((CaptureClosable)resource).Close(); }

  [ComImport, Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356"),
    InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface CaptureItemInterop {
    [PreserveSig] int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr item);
    [PreserveSig] int CreateForMonitor(IntPtr monitor, ref Guid iid, out IntPtr item);
  }
  [DllImport("d3d11.dll", ExactSpelling = true)]
  static extern int D3D11CreateDevice(IntPtr adapter, int driver, IntPtr software,
    uint flags, IntPtr levels, uint levelCount, uint sdk, out IntPtr device,
    out int featureLevel, out IntPtr context);
  [DllImport("d3d11.dll", ExactSpelling = true)]
  static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi, out IntPtr device);

  public static object CreateItem(object factory, IntPtr window) {
    Guid iid = new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");
    IntPtr item = IntPtr.Zero;
    try {
      Marshal.ThrowExceptionForHR(((CaptureItemInterop)factory).CreateForWindow(window, ref iid, out item));
      return Marshal.GetObjectForIUnknown(item);
    } finally { if (item != IntPtr.Zero) Marshal.Release(item); }
  }

  public static object CreateDevice() {
    IntPtr device = IntPtr.Zero, context = IntPtr.Zero, dxgi = IntPtr.Zero, wrapper = IntPtr.Zero;
    try {
      int feature;
      Marshal.ThrowExceptionForHR(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero,
        0x20, IntPtr.Zero, 0, 7, out device, out feature, out context));
      Guid iid = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
      Marshal.ThrowExceptionForHR(Marshal.QueryInterface(device, ref iid, out dxgi));
      Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out wrapper));
      return Marshal.GetObjectForIUnknown(wrapper);
    } finally {
      if (wrapper != IntPtr.Zero) Marshal.Release(wrapper);
      if (dxgi != IntPtr.Zero) Marshal.Release(dxgi);
      if (context != IntPtr.Zero) Marshal.Release(context);
      if (device != IntPtr.Zero) Marshal.Release(device);
    }
  }

  public static string EncodePixels(byte[] pixels, int width, int height) {
    if (width <= 0 || height <= 0 || (long)width * height > 16777216L
      || pixels == null || pixels.LongLength != (long)width * height * 4) {
      throw new InvalidOperationException("capture_geometry_invalid|invalid BGRA surface dimensions");
    }
    using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppPArgb))
    using (MemoryStream stream = new MemoryStream()) {
      BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height),
        ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
      try {
        for (int row = 0; row < height; row++) {
          Marshal.Copy(pixels, row * width * 4, IntPtr.Add(data.Scan0, row * data.Stride), width * 4);
        }
      } finally { bitmap.UnlockBits(data); }
      bitmap.Save(stream, ImageFormat.Png);
      return Convert.ToBase64String(stream.ToArray());
    }
  }
}
