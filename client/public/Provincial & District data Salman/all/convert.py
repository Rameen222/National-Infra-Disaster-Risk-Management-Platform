import os
import pandas as pd

def convert_excel_to_csv():
    # Get current script directory
    base_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Output directory
    output_dir = os.path.join(base_dir, "outputs")
    os.makedirs(output_dir, exist_ok=True)

    # Loop through all files in the directory
    for file in os.listdir(base_dir):
        if file.endswith((".xlsx", ".xls")):
            file_path = os.path.join(base_dir, file)
            
            try:
                # Read Excel file
                df = pd.read_excel(file_path)
                
                # Create CSV filename
                csv_filename = os.path.splitext(file)[0] + ".csv"
                csv_path = os.path.join(output_dir, csv_filename)
                
                # Save as CSV
                df.to_csv(csv_path, index=False)
                
                print(f"Converted: {file} → {csv_filename}")
            
            except Exception as e:
                print(f"Failed to convert {file}: {e}")

if __name__ == "__main__":
    convert_excel_to_csv()